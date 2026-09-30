// ---------------------------------------------------------------------------
// GIVE PEOPLE THE ATS ROLE THEY ACTUALLY WORK.
//
// THE LAST REASON THE ATS LOOKED EMPTY. Re-departmenting put everybody on the
// right desk, and they still saw nothing, because the PulseHRM designation for
// all of them is "Employee" — which maps to ATS role EMPLOYEE, and an ATS
// Employee is not a recruiter. Correct behaviour for the role; wrong role for
// the person.
//
// The attendance sheet says what each one actually is: "Education Recruiter",
// "Medical TL", "BDE (Manufacture)", "Manufacture BED". That is the ATS
// WORKING ROLE, and this app is built for exactly that distinction —
//
//     one login, three independent product roles
//     HRMS: Employee   ATS: Recruiter   Accounts: No Access
//
// — so this sets User.atsRole ONLY. The HRMS designation is untouched: these
// people are Employees in HR terms and that is not in question. Nothing here
// creates a second account, which is the whole point of the model.
//
// WHAT MAPS TO WHAT, most specific first:
//     STL                      -> STL
//     "… TL"                   -> TL
//     "BDE …", "… BDE", "BED"  -> BDE
//     "… Recruiter"            -> RECRUITER
//     a bare desk name         -> RECRUITER   (Education / Medical / Manufacture
//                                              with no level word is somebody
//                                              working that desk)
//     R&D, HR, CEO, Manager    -> left alone. R&D is not recruiting, and a rank
//                                with no desk is not evidence of one.
//
// Dry run by default; --commit writes. Every change is audited.
// ---------------------------------------------------------------------------

const ExcelJS = require('exceljs');
const prisma = require('../src/db');
const { logAudit } = require('../src/utils/audit');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:/Users/user/Downloads/Jan 2026 to Dec 2026_Attendance sheet (2) (2).xlsx';
const COMMIT = process.argv.includes('--commit');
const pad = (s, n) => String(s ?? '').padEnd(n);

const val = (cell) => {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text !== undefined) v = v.text;
  }
  return v === null || v === undefined ? '' : String(v).trim();
};

// Ordered. "Medical TL" must read as TL before it reads as a desk name, and
// "BDE (Education)" as BDE before Education.
const ROLE_RULES = [
  [/\bstl\b/i, 'STL'],
  [/\btl\b/i, 'TL'],
  [/\bbde\b|\bbed\b/i, 'BDE'],
  [/recruiter/i, 'RECRUITER'],
  [/^(education|medical|manufac\w*|manufacrure)$/i, 'RECRUITER'],
];
const atsRoleFor = (title) => {
  const t = String(title || '').trim();
  if (!t) return null;
  const hit = ROLE_RULES.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
};

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const titles = new Map();
  for (const ws of wb.worksheets) {
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const code = val(ws.getRow(r).getCell(1)).toUpperCase();
      const d = val(ws.getRow(r).getCell(3));
      if (code && d) titles.set(code, d);
    }
  }

  const staff = await prisma.employee.findMany({
    where: { employmentStatus: { in: ['Active', 'Notice Period'] }, userId: { not: null } },
    select: {
      id: true, employeeCode: true, name: true, department: true, userId: true,
      user: { select: { atsRole: true, role: true, hrmsRole: true } },
    },
    orderBy: { employeeCode: 'asc' },
  });

  const changes = [];
  const untouched = [];
  for (const e of staff) {
    const title = titles.get(String(e.employeeCode).toUpperCase());
    const want = atsRoleFor(title);
    // Never demote an admin or a manager off the back of a spreadsheet.
    const protectedRole = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER'].includes(e.user.atsRole);
    if (!want || protectedRole || want === e.user.atsRole) {
      untouched.push({ ...e, title: title || '(not in the sheets)', why: protectedRole ? 'protected role' : (!want ? 'no signal' : 'already correct') });
      continue;
    }
    changes.push({ ...e, title, from: e.user.atsRole, to: want });
  }

  console.log('ATS ROLE CHANGES (' + changes.length + ')');
  console.log('  ' + pad('CODE', 9) + pad('NAME', 28) + pad('DEPARTMENT', 16) + pad('SHEET SAYS', 24) + pad('ATS FROM', 12) + 'ATS TO');
  changes.forEach((c) => console.log('  ' + pad(c.employeeCode, 9) + pad(c.name.slice(0, 26), 28)
    + pad(c.department, 16) + pad(c.title, 24) + pad(c.from || '—', 12) + c.to));

  const tally = changes.reduce((m, c) => { m[c.to] = (m[c.to] || 0) + 1; return m; }, {});
  console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '));

  console.log(`\nLEFT ALONE (${untouched.length})`);
  untouched.forEach((u) => console.log('  ' + pad(u.employeeCode, 9) + pad(u.name.slice(0, 26), 28)
    + pad(u.user.atsRole || '—', 14) + pad(u.title, 24) + u.why));

  if (!COMMIT) {
    console.log('\nDRY RUN — re-run with --commit to apply.');
    process.exit(0);
  }

  for (const c of changes) {
    // ONLY atsRole. hrmsRole, the account role and every access flag are left
    // exactly as they are — this is the ATS working role and nothing else.
    // eslint-disable-next-line no-await-in-loop
    await prisma.user.update({ where: { id: c.userId }, data: { atsRole: c.to } });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: `ATS working role set from the attendance record (${c.title})`,
      entity: 'User',
      entityId: c.userId,
      fromValue: c.from || '(none)',
      toValue: c.to,
    });
  }
  console.log(`\n  ${changes.length} updated.`);

  const g = await prisma.user.groupBy({ by: ['atsRole'], _count: true, where: { atsAccess: true } });
  console.log('\nATS ROLES NOW IN USE');
  g.sort((a, b) => b._count - a._count).forEach((r) => console.log('  ' + pad(r.atsRole || '(none)', 18) + r._count));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

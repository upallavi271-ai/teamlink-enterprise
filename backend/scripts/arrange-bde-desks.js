// ---------------------------------------------------------------------------
// PUT THE REAL CLIENTS AND THE REAL BDEs ON THEIR DESKS (2026-10-08).
//
// The rule (utils/bdeDesk.js, utils/scope.js clientWhere):
//     BDE TL                     every client and agreement
//     BDE on the BDE desk        their own clients
//     BDE on a department desk   that department's clients and requirements
//
// THE PROBLEM IT FIXES. redepartment-from-attendance.js put every BDE in the
// BDE department — correct — but the desk they work was only ever in the
// attendance sheet's Designation column ("BDE (Manufacture)", "Manufacture
// BED", "BDE (Education)"), so nothing in the database says that one BDE
// works Manufacturing and another Education. And a client with no Department
// belongs to no desk, so no desk BDE can see it.
//
// WHAT IT CHANGES — nothing is created, nothing is deleted:
//   1. A BDE whose desk the sheet (or their team / seat) names:
//        User.atsScopeDepartments = "BDE,<desk>"
//      the scope Administration -> Users edits; keeps them in BDE as well, so
//      syncLoginToEmployee() leaves it alone on the next employee edit.
//   2. A client with no Department, all of whose requirements are one
//      department's: Client.ownerDepartment = that department. A client whose
//      requirements are split, or who has none, is LISTED, not guessed.
//
// Dry run by default; --commit writes. Every change is audited.
//
//   node scripts/arrange-bde-desks.js ["<attendance sheet.xlsx>"] [--commit]
// ---------------------------------------------------------------------------

const fs = require('fs');
const ExcelJS = require('exceljs');
const prisma = require('../src/db');
const { logAudit } = require('../src/utils/audit');
const { canonicalDepartment, bdeDesks, desksInText } = require('../src/utils/bdeDesk');

const FILE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'C:/Users/user/Downloads/Jan 2026 to Dec 2026_Attendance sheet (2) (2).xlsx';
const COMMIT = process.argv.includes('--commit');
const pad = (s, n) => String(s ?? '').padEnd(n);
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

const val = (cell) => {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v.result !== undefined) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text !== undefined) v = v.text;
  }
  return v === null || v === undefined ? '' : String(v).trim();
};

// Employee code -> the sheet's Designation ("BDE (Manufacture)"). Same
// columns set-ats-roles-from-attendance.js reads. Optional: without the sheet
// the desk comes from what the database already holds.
async function sheetTitles() {
  const titles = new Map();
  if (!fs.existsSync(FILE)) {
    console.log(`(attendance sheet not found at ${FILE} — using the team / seat / scope already stored)\n`);
    return titles;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  for (const ws of wb.worksheets) {
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const code = val(ws.getRow(r).getCell(1)).toUpperCase();
      const d = val(ws.getRow(r).getCell(3));
      if (code && d) titles.set(code, d);
    }
  }
  console.log(`(attendance sheet: ${titles.size} designations read)\n`);
  return titles;
}

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  const titles = await sheetTitles();

  // The spelling each desk is written in here: the Department master first,
  // then whatever the clients and requirements already use.
  const [masters, clientDepts, reqDepts] = await Promise.all([
    prisma.department.findMany({ select: { name: true } }).catch(() => []),
    prisma.client.groupBy({ by: ['ownerDepartment'], _count: true, where: { ownerDepartment: { not: null } } }),
    prisma.requirement.groupBy({ by: ['department'], _count: true, where: { department: { not: null } } }),
  ]);
  const spelling = new Map();
  [...masters.map((m) => m.name), ...clientDepts.map((c) => c.ownerDepartment), ...reqDepts.map((r) => r.department)]
    .forEach((n) => { const c = canonicalDepartment(n); if (c && !spelling.has(c)) spelling.set(c, n); });
  const spell = (desk) => spelling.get(desk) || desk;

  // ---- 1. BDEs -------------------------------------------------------------
  const bdes = await prisma.user.findMany({
    where: { status: { not: 'Inactive' }, OR: [{ atsRole: 'BDE' }, { role: 'BDE' }] },
    select: {
      id: true, name: true, email: true, team: true, atsDepartment: true, atsScopeDepartments: true,
      employee: { select: { id: true, employeeCode: true, department: true, team: true, designation: true } },
    },
    orderBy: { name: 'asc' },
  });

  const bdeChanges = [];
  const bdeRows = [];
  for (const u of bdes) {
    const e = u.employee;
    // eslint-disable-next-line no-await-in-loop
    const seats = e ? await prisma.positionAssignment.findMany({
      where: { employeeId: e.id, toDate: null }, select: { position: { select: { code: true, name: true, team: true } } },
    }).catch(() => []) : [];
    const scope = csv(u.atsScopeDepartments);
    const now = bdeDesks({
      departments: scope.length ? scope : [u.atsDepartment, e && e.department].filter(Boolean),
      texts: [u.team, e && e.team, e && e.designation, ...seats.flatMap((a) => [a.position.code, a.position.name, a.position.team])],
    });
    const title = e && e.employeeCode ? titles.get(String(e.employeeCode).toUpperCase()) : null;
    const fromSheet = desksInText(title);
    const want = fromSheet.length ? fromSheet : now;
    const row = { u, e, title: title || '', now, want };
    bdeRows.push(row);
    if (fromSheet.length && fromSheet.join() !== now.join()) {
      const next = ['BDE', ...fromSheet.map(spell)].join(',');
      bdeChanges.push({ ...row, from: u.atsScopeDepartments || '', to: next });
    }
  }

  console.log(`BDEs (${bdeRows.length})`);
  console.log('  ' + pad('CODE', 10) + pad('NAME', 28) + pad('SHEET SAYS', 24) + pad('DESK NOW', 18) + 'DESK AFTER');
  bdeRows.forEach((r) => console.log('  ' + pad(r.e ? r.e.employeeCode : '—', 10) + pad(String(r.u.name).slice(0, 26), 28)
    + pad(r.title || '—', 24) + pad(r.now.join(', ') || 'BDE (own clients)', 18) + (r.want.join(', ') || 'BDE (own clients)')));
  console.log(`\n  ${bdeChanges.length} BDE scope(s) to set.\n`);

  // ---- 2. Clients with no Department -----------------------------------------
  const orphans = await prisma.client.findMany({
    where: { OR: [{ ownerDepartment: null }, { ownerDepartment: '' }] },
    select: { id: true, name: true, requirements: { select: { department: true } } },
    orderBy: { name: 'asc' },
  });
  const clientChanges = [];
  const unresolved = [];
  orphans.forEach((c) => {
    const desks = [...new Set(c.requirements.map((r) => canonicalDepartment(r.department)).filter(Boolean))];
    if (desks.length === 1 && desks[0] !== 'BDE') clientChanges.push({ c, to: spell(desks[0]), jobs: c.requirements.length });
    else unresolved.push({ c, why: desks.length ? `jobs in ${desks.join(' + ')}` : 'no jobs' });
  });

  console.log(`CLIENTS WITH NO DEPARTMENT (${orphans.length})`);
  clientChanges.forEach((x) => console.log('  ' + pad(x.c.name.slice(0, 44), 46) + '-> ' + pad(x.to, 16) + `(${x.jobs} jobs)`));
  if (unresolved.length) {
    console.log(`\n  LEFT FOR A PERSON TO DECIDE (${unresolved.length}) — set the Department on the client:`);
    unresolved.forEach((x) => console.log('  ' + pad(x.c.name.slice(0, 44), 46) + x.why));
  }
  console.log(`\n  ${clientChanges.length} client department(s) to set.\n`);

  if (!COMMIT) {
    console.log('DRY RUN — re-run with --commit to apply.');
    process.exit(0);
  }

  for (const x of bdeChanges) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.user.update({ where: { id: x.u.id }, data: { atsScopeDepartments: x.to } });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: `BDE desk set from the attendance record (${x.title})`,
      entity: 'User', entityId: x.u.id, fromValue: x.from || '(none)', toValue: x.to,
    });
  }
  for (const x of clientChanges) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.client.update({ where: { id: x.c.id }, data: { ownerDepartment: x.to } });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      action: 'Client department set from its requirements',
      entity: 'Client', entityId: x.c.id, fromValue: '(none)', toValue: x.to,
    });
  }
  console.log(`${bdeChanges.length} BDE scope(s) and ${clientChanges.length} client department(s) updated.`);

  const g = await prisma.client.groupBy({ by: ['ownerDepartment'], _count: true });
  console.log('\nCLIENTS PER DEPARTMENT NOW');
  g.sort((a, b) => b._count - a._count).forEach((r) => console.log('  ' + pad(r.ownerDepartment || '(none)', 20) + r._count));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

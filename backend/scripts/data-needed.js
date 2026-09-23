// ---------------------------------------------------------------------------
// BUILDS "WHAT I STILL NEED" AS A WORKBOOK TO FILL IN.
//
//   node scripts/data-needed.js <out.xlsx>
//
// A list of required fields in a chat message is a thing to re-read and
// misremember. This is the same answer as a file: one tab per thing that is
// missing, PRE-FILLED with what the system already holds, so the work is
// filling blanks rather than building sheets from scratch.
//
// Every tab is keyed on something the importer already understands — employee
// name, client name, requirement code, candidate reference — so a filled tab
// comes straight back in through the same validated import path.
//
// Read-only. It writes a file and touches nothing in the database.
// ---------------------------------------------------------------------------

const fs = require('fs');
const ExcelJS = require('exceljs');
const prisma = require('../src/db');

const OUT = process.argv[2] || 'TeamLink-DATA-NEEDED.xlsx';

const BRAND = 'FF1E3A5F';
const NEED = 'FFB45309';   // a column YOU fill
const HAVE = 'FF64748B';   // a column already filled, for reference
const LIGHT = 'FFF1F5F9';

function header(ws, cols) {
  cols.forEach((c, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = c.h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.need ? NEED : (c.have ? HAVE : BRAND) } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    if (c.note) cell.note = c.note;
    ws.getColumn(i + 1).width = c.w || Math.max(14, c.h.length + 4);
  });
  ws.getRow(1).height = 28;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

function fill(ws, cols, rows) {
  rows.forEach((row, r) => {
    cols.forEach((c, i) => {
      const v = row[c.h];
      if (v !== undefined && v !== null && v !== '') ws.getCell(r + 2, i + 1).value = v;
    });
  });
}

(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TeamLink.Enterprise';

  // ------------------------------------------------------------ Read Me
  const rm = wb.addWorksheet('Read Me', { properties: { tabColor: { argb: BRAND } } });
  rm.getColumn(1).width = 4; rm.getColumn(2).width = 112;
  let r = 1;
  const line = (t, o = {}) => {
    const cell = rm.getCell(r, 2);
    cell.value = t;
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.font = { size: o.size || 11, bold: !!o.bold };
    rm.getRow(r).height = o.h || (t.length > 100 ? 30 : 18);
    r += 1;
  };
  line('TeamLink.Enterprise — what is still needed', { bold: true, size: 18 });
  line('Every tab below is already filled in with what the system holds today. ORANGE columns are the ones to fill; grey columns are there so you know which row you are on — please do not change them, they are how each row is matched back.');
  line('');
  line('IN PRIORITY ORDER', { bold: true, size: 13 });
  line('1.  Employees — nothing in HRMS works until this is filled. Without an email I cannot create a login, and without a login nobody can sign in to see their own work.');
  line('2.  Requirement Owners — all 3,987 requirements currently show no recruiter and no BDE, so no recruiter-wise, team-wise or individual report can be produced.');
  line('3.  Client Details and Client Terms — 905 clients, most with no contact and no commercial terms.');
  line('4.  Invoices — I have 138, all Education. Medical, Manufacturing and IT are missing.');
  line('5.  Candidate Contacts — 12,033 people with no phone and no email, so they cannot be contacted or matched.');
  line('6.  The HRMS tabs (Attendance, Leave, Payroll, Holidays) — fill whenever you are ready; they depend on Employees being done first.');
  line('');
  line('HOW TO SEND IT BACK', { bold: true, size: 13 });
  line('Fill whatever you have and send the file back — a partly filled tab is fine and a tab you skip is simply ignored. Nothing is imported until it has been checked row by row and you have seen the report.');
  line('');
  line('Or send your own sheets in whatever shape they already exist. Eleven different layouts have been converted so far; one more is routine.');

  // ------------------------------------------------------- 1. Employees
  const employees = await prisma.employee.findMany({
    select: { employeeCode: true, name: true, department: true, team: true, designation: true, email: true, user: { select: { email: true } } },
    orderBy: [{ department: 'asc' }, { name: 'asc' }],
  });
  const empCols = [
    { h: 'Employee Code', have: true, w: 16, note: 'Already assigned. Do not change — this is how the row is matched.' },
    { h: 'Full Name', have: true, w: 26 },
    { h: 'Department', have: true, w: 16 },
    { h: 'Official Email', need: true, w: 32, note: 'REQUIRED for a login. Without it this person cannot sign in.' },
    { h: 'Phone', need: true, w: 14 },
    { h: 'Designation', need: true, w: 20, note: 'One of: Super Admin, HR, Manager, Assistant Manager, STL, TL, Employee, Accountant' },
    { h: 'Team', need: true, w: 20, note: 'e.g. Medical Team-A' },
    { h: 'Reporting TL', need: true, w: 22, note: "Their TL's full name. Blank for a TL or above." },
    { h: 'Reporting STL', need: true, w: 22 },
    { h: 'Date of Joining', need: true, w: 16, note: 'YYYY-MM-DD' },
    { h: 'Employment Status', need: true, w: 18, note: 'Active / On Probation / Notice Period / Relieved / Exited' },
  ];
  const ws1 = wb.addWorksheet('1. Employees', { properties: { tabColor: { argb: NEED } } });
  header(ws1, empCols);
  fill(ws1, empCols, employees.map((e) => ({
    'Employee Code': e.employeeCode,
    'Full Name': e.name,
    Department: e.department || '',
    // Pre-fill what is already known, so only the gaps need typing.
    'Official Email': (e.user && e.user.email) || e.email || '',
    Designation: e.designation || '',
    Team: e.team || '',
  })));

  // ------------------------------------------- 2. Requirement owners
  const clients = await prisma.client.findMany({
    select: {
      name: true, industry: true, ownerDepartment: true, accountManager: true,
      contactName: true, contactPhone: true, contactEmail: true, gst: true, pan: true,
      commercialNotes: true, agreementEnd: true,
      _count: { select: { requirements: true } },
    },
    orderBy: { name: 'asc' },
  });
  const ownCols = [
    { h: 'Client Name', have: true, w: 46, note: 'Do not change — this is how the row is matched.' },
    { h: 'Department', have: true, w: 16 },
    { h: 'Requirements', have: true, w: 13 },
    { h: 'Recruiter', need: true, w: 24, note: "Full name, as it appears on the Employees tab." },
    { h: 'TL', need: true, w: 24 },
    { h: 'BDE', need: true, w: 24 },
  ];
  const ws2 = wb.addWorksheet('2. Requirement Owners', { properties: { tabColor: { argb: NEED } } });
  header(ws2, ownCols);
  fill(ws2, ownCols, clients.map((c) => ({
    'Client Name': c.name,
    Department: c.ownerDepartment || '',
    Requirements: c._count.requirements,
  })));

  // ------------------------------------------------- 3. Client details
  const cdCols = [
    { h: 'Client Name', have: true, w: 46 },
    { h: 'Industry', have: true, w: 20 },
    { h: 'Contact Person', need: true, w: 24 },
    { h: 'Designation', need: true, w: 20 },
    { h: 'Phone', need: true, w: 16 },
    { h: 'Email', need: true, w: 30 },
    { h: 'GST Number', need: true, w: 20 },
    { h: 'PAN', need: true, w: 14 },
    { h: 'Address', need: true, w: 34 },
    { h: 'City', need: true, w: 16 },
    { h: 'State', need: true, w: 16 },
    { h: 'Pincode', need: true, w: 12 },
  ];
  const ws3 = wb.addWorksheet('3. Client Details', { properties: { tabColor: { argb: NEED } } });
  header(ws3, cdCols);
  fill(ws3, cdCols, clients.map((c) => ({
    'Client Name': c.name,
    Industry: c.industry || '',
    'Contact Person': c.contactName || '',
    Phone: c.contactPhone || '',
    Email: c.contactEmail || '',
    'GST Number': c.gst || '',
    PAN: c.pan || '',
  })));

  // --------------------------------------------------- 4. Client terms
  const ctCols = [
    { h: 'Client Name', have: true, w: 46 },
    { h: 'Terms on record', have: true, w: 40, note: 'What is already stored, for reference.' },
    { h: 'Fee %', need: true, w: 10, note: 'Your placement fee, e.g. 8.33' },
    { h: 'GST %', need: true, w: 10, note: 'Usually 18' },
    { h: 'TDS %', need: true, w: 10, note: 'Usually 10' },
    { h: 'Payment Terms', need: true, w: 34 },
    { h: 'Guarantee Period', need: true, w: 18, note: 'e.g. 30 Days / 90 Days' },
    { h: 'Agreement Date', need: true, w: 16, note: 'YYYY-MM-DD' },
    { h: 'Agreement Expiry', need: true, w: 16 },
  ];
  const ws4 = wb.addWorksheet('4. Client Terms', { properties: { tabColor: { argb: NEED } } });
  header(ws4, ctCols);
  fill(ws4, ctCols, clients.map((c) => ({
    'Client Name': c.name,
    'Terms on record': (c.commercialNotes || '').replace(/\s+/g, ' ').slice(0, 160),
    'Agreement Expiry': c.agreementEnd || '',
  })));

  // -------------------------------------------------------- 5. Invoices
  const invCols = [
    { h: 'Invoice Number', need: true, w: 18 },
    { h: 'Client Name', need: true, w: 40, note: 'Must match a client the system already knows — see the Client Details tab.' },
    { h: 'Candidate Name', need: true, w: 24 },
    { h: 'Candidate Phone', need: true, w: 16 },
    { h: 'Invoice Date', need: true, w: 14, note: 'YYYY-MM-DD' },
    { h: 'Due Date', need: true, w: 14 },
    { h: 'Amount (fee)', need: true, w: 14, note: 'Before GST and TDS. Digits only.' },
    { h: 'GST %', need: true, w: 10 },
    { h: 'TDS %', need: true, w: 10 },
    { h: 'Status', need: true, w: 16, note: 'Pending / Partially Paid / Paid / Overdue / Cancelled' },
    { h: 'Received Amount', need: true, w: 16 },
    { h: 'Payment Received Date', need: true, w: 20 },
    { h: 'Offered CTC', need: true, w: 14 },
    { h: 'Joining Date', need: true, w: 14 },
    { h: 'Notes', need: true, w: 30 },
  ];
  const ws5 = wb.addWorksheet('5. Invoices', { properties: { tabColor: { argb: NEED } } });
  header(ws5, invCols);
  const haveInv = await prisma.invoice.count();
  ws5.getCell(2, 1).value = `— ${haveInv} invoices already imported (Education only). Add Medical, Manufacturing and IT below, from row 3. —`;
  ws5.getCell(2, 1).font = { italic: true, color: { argb: HAVE } };

  // ---------------------------------------------- 6. Candidate contacts
  const contactless = await prisma.candidate.findMany({
    where: {
      AND: [
        { OR: [{ email: null }, { email: '' }] },
        { OR: [{ phone: null }, { phone: '' }] },
      ],
    },
    select: { name: true, externalRef: true, education: true, specialization: true, location: true },
    orderBy: { name: 'asc' },
  });
  const ccCols = [
    { h: 'Reference', have: true, w: 20, note: 'Do not change — this is how the row is matched back to the right person.' },
    { h: 'Candidate Name', have: true, w: 26 },
    { h: 'Qualification', have: true, w: 18 },
    { h: 'Specialisation', have: true, w: 20 },
    { h: 'Location', have: true, w: 18 },
    { h: 'Phone', need: true, w: 16 },
    { h: 'Email', need: true, w: 30 },
  ];
  const ws6 = wb.addWorksheet('6. Candidate Contacts', { properties: { tabColor: { argb: NEED } } });
  header(ws6, ccCols);
  fill(ws6, ccCols, contactless.map((c) => ({
    Reference: c.externalRef || '',
    'Candidate Name': c.name,
    Qualification: c.education || '',
    Specialisation: c.specialization || '',
    Location: c.location || '',
  })));

  // ------------------------------------------------------- 7-10. HRMS
  const hrmsTabs = [
    ['7. Attendance', [
      { h: 'Employee Code', need: true, w: 16 }, { h: 'Date', need: true, w: 14, note: 'YYYY-MM-DD' },
      { h: 'Check In', need: true, w: 12, note: 'HH:MM' }, { h: 'Check Out', need: true, w: 12 },
      { h: 'Status', need: true, w: 16, note: 'Present / Absent / Half Day / Leave / Holiday / Week Off' },
    ]],
    ['8. Leave', [
      { h: 'Employee Code', need: true, w: 16 }, { h: 'Leave Type', need: true, w: 18, note: 'Casual / Sick / Earned / Loss of Pay …' },
      { h: 'Opening Balance', need: true, w: 16 }, { h: 'From Date', need: true, w: 14 },
      { h: 'To Date', need: true, w: 14 }, { h: 'Days', need: true, w: 10 },
      { h: 'Reason', need: true, w: 28 }, { h: 'Status', need: true, w: 14, note: 'Approved / Rejected / Pending' },
    ]],
    ['9. Payroll', [
      { h: 'Employee Code', need: true, w: 16 }, { h: 'Annual CTC', need: true, w: 14 },
      { h: 'Basic', need: true, w: 12 }, { h: 'HRA', need: true, w: 12 },
      { h: 'Other Allowances', need: true, w: 16 }, { h: 'PF Number', need: true, w: 18 },
      { h: 'ESI Number', need: true, w: 18 }, { h: 'Bank Name', need: true, w: 20 },
      { h: 'Account Number', need: true, w: 20 }, { h: 'IFSC', need: true, w: 14 },
      { h: 'PAN', need: true, w: 14 }, { h: 'Aadhaar', need: true, w: 18 },
    ]],
    ['10. Holidays', [
      { h: 'Date', need: true, w: 14, note: 'YYYY-MM-DD' }, { h: 'Holiday Name', need: true, w: 30 },
      { h: 'Applies To', need: true, w: 24, note: 'All, or a department name' },
    ]],
  ];
  hrmsTabs.forEach(([name, cols]) => {
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: 'FF94A3B8' } } });
    header(ws, cols);
  });

  fs.writeFileSync(OUT, Buffer.from(await wb.xlsx.writeBuffer()));
  console.log(`Wrote ${OUT}`);
  console.log(`  1. Employees          ${employees.length} rows pre-filled`);
  console.log(`  2. Requirement Owners ${clients.length} clients pre-filled`);
  console.log(`  3. Client Details     ${clients.length} clients pre-filled`);
  console.log(`  4. Client Terms       ${clients.length} clients pre-filled`);
  console.log(`  5. Invoices           blank (${haveInv} already imported)`);
  console.log(`  6. Candidate Contacts ${contactless.length} people with no phone and no email`);
  console.log('  7-10. Attendance, Leave, Payroll, Holidays — blank templates');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });

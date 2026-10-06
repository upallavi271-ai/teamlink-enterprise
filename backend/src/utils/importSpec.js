// ---------------------------------------------------------------------------
// THE IMPORT SPEC — ONE DESCRIPTION OF THE WORKBOOK, USED TWICE.
//
// The template the user fills in and the importer that reads it back are
// generated from THIS FILE. That is the whole point: a template written by
// hand and a parser written by hand drift apart on the first change, and the
// person who finds out is the one whose 400-row sheet half-imported.
//
//   scripts/import-template.js  -> writes the .xlsx from these definitions
//   routes/dataImport.js        -> validates and imports against the same ones
//
// HOW THE SHEETS REFER TO EACH OTHER: by BUSINESS KEY, never by internal id.
// Nobody filling a spreadsheet knows a cuid, so a requirement names its client
// "Orbit Software Solutions" and an application names its candidate by email.
// Each sheet below declares `key` (what makes a row unique, so a re-import
// UPDATES rather than duplicates) and `lookups` (how its text becomes a
// foreign key). Sheets import in the order listed, because a requirement needs
// its client to exist first.
//
// THE HEADERS ARE THE CONTRACT. The column headers below are exactly the ones
// on TeamLink_Import_Templates.xlsx (the workbook users actually fill in), and
// the parser finds a column by its header text. A header that is renamed here
// silently stops being read there.
//
// DATES: DD-MM-YYYY or YYYY-MM-DD. Excel will happily hand over a serial
// number, a string or a Date depending on how the cell was typed; the importer
// coerces all of them.
//
// COLUMN FLAGS beyond the obvious (h header, f field, req, t type, list):
//   legacy: true   read when an older workbook has it, but no longer put on
//                  the generated template (the current workbook dropped it).
//   store: false   the app has nowhere to keep this yet. The column is READ so
//                  that the check report can say "N rows had a value here and
//                  it was NOT stored, because …" — never silently dropped.
//   label: true    a column that names the row rather than carrying data (the
//                  HR Policy "Setting" column). A row with only a label in it
//                  is a blank row.
// ---------------------------------------------------------------------------

const {
  ALL_STAGE_CODES, ATS_ROLES, AGREEMENT_STATUSES, AGREEMENT_TEMPLATES, INVOICE_TRIGGERS, RISK_FLAGS,
  SALARY_TYPES, JOB_PREFERENCES, CANDIDATE_AVAILABILITY, CANDIDATE_WORK_MODES, CANDIDATE_EMPLOYMENT_TYPES,
  CANDIDATE_JOB_PREFERENCES, INTERVIEW_TYPES, INTERVIEW_STATUS_CODES, FEEDBACK_KINDS,
} = require('./atsVocab');

// --- Allowed-value lists, which become dropdowns in the workbook -----------
// Every one of these is copied from the schema's own comment or from the
// vocabulary module, so a dropdown cannot offer a value the database rejects.
const LISTS = {
  designation: ['Super Admin', 'HR', 'Manager', 'Assistant Manager', 'STL', 'TL', 'Employee', 'Accountant'],
  employmentStatus: ['Active', 'On Probation', 'Notice Period', 'Exit Process', 'Relieved', 'Exited'],
  employeeType: ['Full-time', 'Contract', 'Intern'],
  gender: ['Male', 'Female', 'Other'],
  experience: ['Fresher', 'Experienced'],
  yesNo: ['Yes', 'No'],
  // Client lifecycle (2026-10-03): an import creates ACTIVE clients only;
  // Pause / Reactivate / Archive are actions with a reason, never a cell.
  clientStatus: ['Active'],
  clientType: ['Direct', 'Vendor', 'Partner'],
  priority: ['High', 'Medium', 'Low'],
  requirementStatus: ['DRAFT', 'OPEN', 'CLOSED'],
  hiringType: ['Client Placement', 'TeamLink Internal Hire'],
  employmentTypeReq: ['Full Time', 'Part Time', 'Contract', 'Internship'],
  workMode: ['Work From Office', 'Hybrid', 'Remote'],
  stage: ALL_STAGE_CODES,
  interviewResult: ['Recommended', 'Hold', 'Not Selected'],
  interviewMode: ['Online', 'In Person', 'Telephonic'],
  offerStatus: ['Not Issued', 'Offer Released', 'Offer Accepted', 'Offer Declined'],
  invoiceStatus: ['Pending', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'],
  businessType: ['Private Limited', 'Public Limited', 'LLP', 'Partnership', 'Proprietorship'],
  // --- added with the full-workbook import -------------------------------
  accountType: ['Current', 'Savings'],
  loginStatus: ['Active', 'Inactive', 'Suspended'],
  // The product-role vocabularies are the ones Administration → Users and
  // Administration → Designations accept. ATS is ATS_ROLES without CLIENT (a
  // client login is tied to a client, never to an employee code).
  hrmsRole: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR', 'ACCOUNTANT', 'EMPLOYEE', 'NONE'],
  atsRole: [...ATS_ROLES.filter((r) => r !== 'CLIENT'), 'NONE'],
  accountsRole: ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'NONE'],
  landing: ['hrms', 'ats', 'accounts'],
  holidayType: ['National Holiday', 'Festival', 'Optional'],
  leaveUnit: ['yr', 'month', 'unpaid'],
  assetStatus: ['Available', 'Assigned', 'In Repair', 'Retired'],
  invoiceTrigger: INVOICE_TRIGGERS,
  agreementStatus: AGREEMENT_STATUSES,
  agreementTemplate: AGREEMENT_TEMPLATES,
  riskFlag: RISK_FLAGS,
  salaryType: SALARY_TYPES,
  jobPreference: JOB_PREFERENCES,
  availability: CANDIDATE_AVAILABILITY,
  candidateWorkMode: CANDIDATE_WORK_MODES,
  candidateEmploymentType: CANDIDATE_EMPLOYMENT_TYPES,
  candidateJobPreference: CANDIDATE_JOB_PREFERENCES,
  // "TeamLink" is how the app SHOWS the Internal side; stored as Internal.
  rejectedBy: ['Client', 'TeamLink', 'Candidate'],
  interviewType: INTERVIEW_TYPES,
  interviewStatus: INTERVIEW_STATUS_CODES,
  feedbackBy: FEEDBACK_KINDS,
  joiningStatus: ['Not Scheduled', 'Joining Scheduled', 'Joined', 'Dropped'],
  documentsStatus: ['Pending', 'Submitted', 'Verified'],
  sentVia: ['Email', 'WhatsApp', 'Post', 'By hand'],
  paymentMethod: ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Other'],
};

// THE REASONS THAT MAKE SENSE FOR EACH SIDE of a rejection. A mirror of
// frontend/src/atsVocab.js REJECTION_REASONS_BY_SIDE (the Reject dialog's own
// lists), keyed by the STORED side. "Did not attend the interview" is never a
// client's reason; "Skills mismatch" is never the candidate's.
const REJECTION_REASONS_BY_SIDE = {
  Client: [
    'Skills Mismatch', 'Insufficient Experience', 'Interview Performance', 'Communication',
    'Salary Expectation', 'Not Shortlisted', 'Not Selected', 'Position Filled', 'Position Closed', 'Other',
  ],
  Internal: [
    'Profile Not Matching', 'Not Eligible', 'Failed Screening', 'Low AI Interview Score',
    'Duplicate Profile', 'Background / Documentation', 'Other',
  ],
  Candidate: [
    'Not Interested', 'Did Not Attend Interview', 'Offer Declined', 'Did Not Join',
    'Accepted Another Offer', 'Salary Expectation', 'Notice Period', 'Location / Relocation',
    'Not Reachable', 'Other',
  ],
};

// THE HR POLICY SHEET is key/value, not one-record-per-row: each row is one
// setting, and "Your value" is what to set it to. `field` is the HrConfig
// column; `kind` is how the value is read. A setting with no field is one the
// app has nowhere to keep yet, and is reported as not stored.
const HR_POLICY_SETTINGS = [
  { label: 'Late after (HH:MM)', field: 'graceTime', kind: 'time', what: 'A check-in after this time is Late' },
  { label: 'Free late arrivals per month', field: 'freeLateArrivalsPerMonth', kind: 'int', what: 'Late marks beyond this cost half a day' },
  { label: 'Free early logouts per month', field: 'freeEarlyLogoutsPerMonth', kind: 'int', what: 'Early logouts beyond this are penalised' },
  { label: 'Earliest excusable early logout (HH:MM)', field: 'earliestExcusableEarlyLogout', kind: 'time', what: 'Leaving before this is never excused' },
  { label: 'Hours for a half day', field: 'halfDayHours', kind: 'float', what: 'Less than this = absent' },
  { label: 'Hours for a full day', field: 'fullDayHours', kind: 'float', what: 'Less than this = half day' },
  { label: 'Notice period (days)', field: 'noticePeriodDays', kind: 'int', what: 'Sets last working day on resignation' },
  { label: 'Weekly off days', field: null, kind: 'text', what: 'e.g. Sunday; 2nd and 4th Saturday', why: 'the app has no weekly-off setting yet (HrConfig has no such column)' },
  { label: 'Weekends paid? (Yes/No)', field: 'weekendsPaid', kind: 'bool', what: 'Attendance to pay' },
  { label: 'Unmarked days unpaid? (Yes/No)', field: 'unmarkedDaysUnpaid', kind: 'bool', what: 'Attendance to pay' },
  { label: 'Paid leave days per month', field: 'paidLeaveDaysPerMonth', kind: 'int', what: 'Leave to pay' },
  { label: 'Max % of a team on leave the same day', field: 'concurrentLeaveCapPct', kind: 'pct', what: 'Blocks too many people off together' },
  { label: 'Max people of a team on leave the same day', field: 'concurrentLeaveCapFlat', kind: 'int', what: 'Same, as a number' },
  { label: 'Leave of this many days or more needs a reason', field: 'leaveReasonThresholdDays', kind: 'int', what: 'Leave approval' },
];

// Sheets of the workbook that are imported somewhere else. The Data Import
// check names them, with where to take them, instead of calling them skipped.
const IMPORTED_ELSEWHERE = {
  'Bank Statement': 'Imported through Accounts → Import (Bank & Reconciliation), not Data Import. Upload this workbook there and pick the "Bank Statement" sheet; the bank account is chosen on that screen. Import the Bank Accounts sheet here first so the account exists.',
  'Office Expenses': 'Imported through Accounts → Import (Office & Expenses), not Data Import. Upload this workbook there and pick the "Office Expenses" sheet.',
};

// Sheets that explain the workbook and carry no records.
const REFERENCE_SHEETS = ['READ ME', 'Read Me', 'Field Guide', 'Lists', 'Current Data Gaps', 'In-App Setup'];

// A column: `h` header, `f` model field, `req` required, `t` type,
// `list` allowed values, `help` the note under the header, `eg` the example.
const c = (h, f, opts = {}) => ({ h, f, t: 'text', ...opts });
// A column the app cannot keep yet. Read, counted and reported — see above.
const ns = (h, why, opts = {}) => c(h, `_ns_${h}`, { store: false, why, ...opts });

// ---------------------------------------------------------------------------
// THE SHEETS, IN IMPORT ORDER.
// ---------------------------------------------------------------------------
const SHEETS = [
  // --- 1. Organisation -----------------------------------------------------
  {
    name: 'Company',
    product: 'Setup',
    model: 'company',
    key: ['(the one company)'],
    title: 'Your company — letterhead, GST and bank details for invoices',
    note: 'ONE ROW. This is the company record every invoice prints. Re-importing updates it.',
    columns: [
      c('Company Name', 'name', { req: true, eg: 'Sample Staffing Consultants' }),
      c('Legal Name', 'legalName', { help: 'Printed on tax invoices and agreements.', eg: 'Sample Staffing Consultants OPC Pvt Ltd' }),
      c('Tagline', 'tagline', { eg: 'Right people, right place' }),
      c('GSTIN', 'gstin', { help: '15 characters.', eg: '36AAAAA0000A1Z5' }),
      ns('PAN', 'the Company record has no PAN field yet — a schema change is needed', { eg: 'AAAAA0000A' }),
      ns('TAN', 'the Company record has no TAN field yet — a schema change is needed', { eg: 'HYDA00000A' }),
      c('SAC Code', 'sac', { help: 'Printed on each invoice line.', eg: '998512' }),
      c('Address', 'address', { eg: 'Plot 10, Sample Towers, Madhapur' }),
      c('City', 'city', { eg: 'Hyderabad' }),
      c('State', 'state', { help: 'Place of supply: decides CGST+SGST or IGST.', eg: 'Telangana' }),
      c('PIN', 'pin', { eg: '500081' }),
      c('Official Email', 'email', { eg: 'accounts@sample-staffing.example' }),
      c('Official Phone', 'phone', { eg: '9000000000' }),
      c('Head Office', 'hq', { eg: 'Hyderabad, Telangana' }),
      c('Bank Name', 'bankName', { eg: 'Sample Bank' }),
      c('Account Name', 'accountName', { eg: 'Sample Staffing Consultants' }),
      c('Account Number', 'accountNumber', { help: 'Type it as text so leading zeros survive.', eg: '000000000000' }),
      c('IFSC', 'ifsc', { eg: 'SAMP0000001' }),
      c('Branch', 'branch', { eg: 'Madhapur' }),
      c('Account Type', 'accountType', { t: 'list', list: 'accountType', eg: 'Current' }),
      c('UPI ID', 'upi', { eg: 'sample@upi' }),
      c('Invoice Terms', 'invoiceTerms', { help: 'Printed as "Terms" on invoices.', eg: 'Net 7' }),
      c('Policies', '_policies', { help: 'Comma separated.', eg: 'Leave Policy, POSH Policy' }),
    ],
  },
  {
    name: 'Departments',
    product: 'Setup',
    model: 'department',
    key: ['name'],
    title: 'Departments and their teams',
    note: 'FILL THIS FIRST. Every other sheet refers to a department by this name, so a typo here becomes a missing link later. One row per TEAM; repeat the department name for each of its teams. A department with no teams yet: leave Team blank.',
    columns: [
      c('Department', 'name', { req: true, help: 'Medical, IT, Manufacturing, Educational, BDE, Accounts, HR …', eg: 'Medical' }),
      c('Team', 'team', { help: 'A team inside that department. Blank if the department has no teams.', eg: 'Team-A' }),
    ],
  },
  {
    name: 'Specialisations',
    product: 'Setup',
    model: 'specialisation',
    key: ['department', 'name'],
    title: 'Specialisations within a department',
    note: 'The second level of the hierarchy: Medical → MBBS, Dermatology, Gynaecology, Paediatrics, Cardiology. Requirements and candidates can then be filtered by specialisation. Department must already appear on the Departments sheet.',
    columns: [
      c('Department', 'department', { req: true, eg: 'Medical' }),
      c('Specialisation', 'name', { req: true, eg: 'Dermatology' }),
    ],
  },

  // --- 2. HRMS -------------------------------------------------------------
  {
    name: 'Employees',
    product: 'HRMS',
    model: 'employee',
    key: ['employeeCode'],
    title: 'Employee master (HRMS)',
    note: 'ONE EMPLOYEE = ONE ROW = ONE LOGIN. Employee Code is the unique key — re-importing the same code UPDATES that person rather than creating a second record. Designation decides what they can reach in HRMS, ATS and Accounts, so it is required.',
    columns: [
      c('Employee Code', 'employeeCode', { req: true, help: 'Unique. Your own numbering — TL001, EMP-1042, anything consistent.', eg: 'EX001' }),
      c('Full Name', 'name', { req: true, eg: 'Sample Person One' }),
      c('Official Email', 'email', { help: 'Also used as the login email unless Login Email is filled.', eg: 'person.one@sample.example' }),
      c('Phone', 'phone', { eg: '9000000001' }),
      c('Department', 'department', { req: true, help: 'Must match the Departments sheet.', eg: 'Medical' }),
      c('Team', 'team', { help: 'Must match a team of that department.', eg: '' }),
      c('Designation', 'designation', { req: true, t: 'list', list: 'designation', help: 'Decides their roles and which products they see. Recruiters and BDEs are "Employee" here; set their ATS role on the Users & Logins sheet.', eg: 'TL' }),
      c('Reporting TL', 'tl', { help: 'Full name of their TL. Leave blank for a TL or above.', eg: '' }),
      c('Reporting STL', 'stl', { help: 'Full name of their STL.', eg: '' }),
      c('Date of Joining', 'dateOfJoining', { t: 'date', eg: '01-04-2025' }),
      c('Employment Status', 'employmentStatus', { t: 'list', list: 'employmentStatus', eg: 'Active' }),
      c('Employee Type', 'employeeType', { t: 'list', list: 'employeeType', eg: 'Full-time' }),
      c('Experience', 'employmentExperience', { t: 'list', list: 'experience', eg: 'Experienced' }),
      c('Branch / Office', 'branch', { eg: 'Hyderabad' }),
      c('Work Location', 'location', { eg: 'Hyderabad' }),
      c('Date of Birth', 'dateOfBirth', { t: 'date', eg: '10-01-1995' }),
      c('Gender', 'gender', { t: 'list', list: 'gender', eg: 'Female' }),
      c('Blood Group', 'bloodGroup', { eg: 'O+' }),
      c('Address Line 1', 'addressLine1', { eg: '1-2-3, Sample Colony' }),
      c('Address Line 2', 'addressLine2'),
      c('City', 'city', { eg: 'Hyderabad' }),
      c('District', 'district', { eg: 'Hyderabad' }),
      c('State', 'state', { eg: 'Telangana' }),
      c('Postal Code', 'postalCode', { eg: '500081' }),
      c('Country', 'country', { eg: 'India' }),
      c('Emergency Contact Name', 'emergencyContactName', { eg: 'Sample Parent' }),
      c('Emergency Contact Phone', 'emergencyContactPhone', { eg: '9000000011' }),
      c('Emergency Contact Relation', 'emergencyContactRelation', { eg: 'Father' }),
      c('Education', 'educationDetails', { eg: 'MBA, Sample University, 2018' }),
      c('Skills', 'skills', { help: 'Comma separated.', eg: 'Sourcing, Screening' }),
      c('Shift', 'shift', { eg: 'General (9:00 AM – 6:00 PM)' }),
      c('Bank Name', 'bankName', { eg: 'Sample Bank' }),
      c('Bank Account Number', 'bankAccountNumber', { eg: '000000000001' }),
      c('IFSC Code', 'ifscCode', { eg: 'SAMP0000001' }),
      c('PAN', 'panNumber', { eg: 'AAAAA0001A' }),
      // THE FULL AADHAAR NUMBER IS NEVER STORED (Aadhaar Act s.29 — see the
      // schema comment on Employee.aadhaarNumber). The current workbook has no
      // Aadhaar column; an older one that does is READ ONLY TO SAY SO.
      ns('Aadhaar', 'the full Aadhaar number is never stored (Aadhaar Act s.29). Employees verify it themselves in My Profile, which keeps only the last 4 digits', { legacy: true }),
      c('UAN', 'uanNumber', { eg: '100000000001' }),
      c('PF Number', 'pfNumber'),
      c('ESI Number', 'esiNumber'),
      c('Create Login', '_createLogin', { t: 'list', list: 'yesNo', help: 'Yes creates a login for this person. No password is set or sent: they get access through the set-password link from Administration → Users.', eg: 'Yes' }),
      c('Login Email', '_loginEmail', { help: 'Only if it differs from Official Email.', eg: '' }),
      c('Reporting Manager Code', '_reportingManager', { help: 'The Employee Code of their reporting manager (org chart, approvals).', eg: 'EX000' }),
      c('Last Working Day', '_lastWorkingDay', { t: 'date', help: 'Only for Notice Period / Exit Process / Relieved / Exited. Recorded as their resignation\'s last working day.', eg: '' }),
    ],
  },
  {
    name: 'Positions',
    product: 'HRMS',
    model: 'position',
    key: ['code'],
    title: 'Positions (seats) — MED-1, EDU BDE 1 …',
    note: 'A seat outlives the person in it: requirements and work history are kept per seat. Seat Code is the key. Current Holder Code puts that employee in the seat from Holder From Date; whoever held it before is moved out on that day.',
    columns: [
      c('Seat Code', 'code', { req: true, eg: 'MED-1' }),
      c('Seat Name', 'name', { eg: 'Medical Recruiter 1' }),
      c('Department', 'department', { req: true, help: 'Must match the Departments sheet.', eg: 'Medical' }),
      c('Team', 'team', { eg: '' }),
      c('Active', '_active', { t: 'list', list: 'yesNo', eg: 'Yes' }),
      c('Current Holder Code', '_holder', { help: 'An Employee Code.', eg: 'EX002' }),
      c('Holder From Date', '_holderFrom', { t: 'date', eg: '15-06-2026' }),
      c('Notes', 'notes', { eg: '' }),
    ],
  },
  {
    name: 'Users & Logins',
    product: 'Setup',
    model: 'login',
    key: ['loginEmail'],
    title: 'Logins and what each one can reach in HRMS, ATS and Accounts',
    note: 'One row per login, tied to an Employee Code. NO PASSWORD IS SET OR SENT by the import: a new login gets an unguessable password and the person signs in through the set-password link issued from Administration → Users. Blank cells leave the login as it is (or, for a new login, take what the employee\'s designation gives).',
    columns: [
      c('Login Email', 'email', { req: true, eg: 'person.two@sample.example' }),
      c('Employee Code', '_employee', { req: true, eg: 'EX002' }),
      c('Status', 'status', { t: 'list', list: 'loginStatus', help: 'Inactive = cannot sign in.', eg: 'Active' }),
      c('HRMS Access', '_hrmsAccess', { t: 'list', list: 'yesNo', eg: 'Yes' }),
      c('HRMS Role', 'hrmsRole', { t: 'list', list: 'hrmsRole', eg: 'EMPLOYEE' }),
      c('ATS Access', '_atsAccess', { t: 'list', list: 'yesNo', eg: 'Yes' }),
      c('ATS Role', 'atsRole', { t: 'list', list: 'atsRole', eg: 'RECRUITER' }),
      c('Accounts Access', '_accountsAccess', { t: 'list', list: 'yesNo', eg: 'No' }),
      c('Accounts Role', 'accountsRole', { t: 'list', list: 'accountsRole', eg: 'NONE' }),
      c('ATS Departments', 'atsScopeDepartments', { help: 'Comma separated department names.', eg: 'Medical' }),
      c('ATS Teams', 'atsScopeTeams', { help: 'Comma separated team names.', eg: '' }),
      c('Landing Workspace', 'landingWorkspace', { t: 'list', list: 'landing', eg: 'ats' }),
    ],
  },
  {
    name: 'Shifts',
    product: 'HRMS',
    model: 'shift',
    key: ['name'],
    title: 'Shift patterns',
    note: 'Shift Name is the key.',
    columns: [
      c('Shift Name', 'name', { req: true, eg: 'General' }),
      c('Start Time', 'startTime', { req: true, t: 'time', help: 'HH:MM, 24-hour.', eg: '09:00' }),
      c('End Time', 'endTime', { req: true, t: 'time', help: 'HH:MM, 24-hour.', eg: '18:00' }),
      c('Active', '_active', { t: 'list', list: 'yesNo', eg: 'Yes' }),
    ],
  },
  {
    name: 'Holidays',
    product: 'HRMS',
    model: 'holiday',
    key: ['date', 'name'],
    title: 'Holiday calendar',
    note: 'Date + Holiday Name is the key.',
    columns: [
      c('Holiday Name', 'name', { req: true, eg: 'Sample Festival' }),
      c('Date', 'date', { req: true, t: 'date', eg: '14-01-2027' }),
      c('Type', 'type', { t: 'list', list: 'holidayType', eg: 'Festival' }),
    ],
  },
  {
    name: 'Leave Types',
    product: 'HRMS',
    model: 'leaveType',
    key: ['code'],
    title: 'Leave types',
    note: 'Code is the key. Leave Balances refer to a leave type by its Leave Name.',
    columns: [
      c('Code', 'code', { req: true, eg: 'CL' }),
      c('Leave Name', 'name', { req: true, eg: 'Casual Leave' }),
      c('Days Allowed', 'cap', { req: true, t: 'number', help: 'Whole days per period.', eg: '12' }),
      c('Per', 'unit', { req: true, t: 'list', list: 'leaveUnit', eg: 'yr' }),
      c('Carry Forward', '_carries', { t: 'list', list: 'yesNo', eg: 'No' }),
      c('Active', '_active', { t: 'list', list: 'yesNo', eg: 'Yes' }),
    ],
  },
  {
    name: 'Leave Balances',
    product: 'HRMS',
    model: 'leaveBalance',
    key: ['_employee', 'type'],
    title: 'Opening leave balances',
    note: 'Employee Code + Leave Type is the key. Leave Type is a Leave Name from the Leave Types sheet.',
    columns: [
      c('Employee Code', '_employee', { req: true, eg: 'EX001' }),
      c('Leave Type', '_type', { req: true, eg: 'Casual Leave' }),
      c('Entitled Days', 'total', { req: true, t: 'number', eg: '12' }),
      c('Taken Days', 'taken', { t: 'number', eg: '3' }),
    ],
  },
  {
    name: 'Assets',
    product: 'HRMS',
    model: 'asset',
    key: ['assetCode'],
    title: 'Asset register',
    note: 'Asset Code is the key.',
    columns: [
      c('Asset Code', 'assetCode', { req: true, eg: 'AST-001' }),
      c('Asset Name', 'name', { req: true, eg: 'Sample Laptop 14"' }),
      c('Category', 'category', { eg: 'Laptop' }),
      c('Status', 'status', { t: 'list', list: 'assetStatus', eg: 'Assigned' }),
      c('Assigned To Code', '_assignedTo', { help: 'An Employee Code.', eg: 'EX001' }),
      c('Purchase Date', 'purchaseDate', { t: 'date', eg: '10-02-2025' }),
      c('Warranty Until', 'warrantyUntil', { t: 'date', eg: '10-02-2028' }),
    ],
  },

  // --- 3. ATS --------------------------------------------------------------
  {
    name: 'Clients',
    product: 'ATS',
    model: 'client',
    key: ['name'],
    title: 'Client companies (ATS)',
    note: 'Client Name is the key — requirements and invoices refer to a client by this exact name, so keep it consistent. Commercial terms here are what the invoice defaults to. A blank cell never overwrites what the client already has (a blank GST % keeps 18%).',
    columns: [
      c('Client Name', 'name', { req: true, help: 'The name used everywhere else in the workbook.', eg: 'Sample Hospital, Hyderabad' }),
      c('Legal Name', 'legalName', { eg: 'Sample Hospitals Pvt Ltd' }),
      c('Industry', 'industry', { eg: 'Healthcare' }),
      c('Client Type', 'clientType', { t: 'list', list: 'clientType', eg: 'Direct' }),
      c('Status', 'status', { t: 'list', list: 'clientStatus', help: 'New clients only: Active (blank = Active). The status of a client already on file is never changed by an import — use Pause / Reactivate / Archive on the client.', eg: 'Active' }),
      c('Priority', 'priority', { t: 'list', list: 'priority', eg: 'High' }),
      c('Owning Department', 'ownerDepartment', { help: 'Which department of yours handles this client.', eg: 'Medical' }),
      c('Website', 'website', { eg: 'https://hospital.example' }),
      c('Landline', 'landline', { eg: '' }),
      c('Primary Contact Name', 'contactName', { eg: 'Sample HR Head' }),
      c('Primary Contact Designation', 'contactDesignation', { eg: 'HR Manager' }),
      c('Primary Contact Phone', 'contactPhone', { eg: '9000000101' }),
      c('Primary Contact Email', 'contactEmail', { eg: 'hr@hospital.example' }),
      c('Secondary Contact Name', 'secondaryContactName'),
      c('Secondary Contact Phone', 'secondaryContactPhone'),
      c('Secondary Contact Email', 'secondaryContactEmail'),
      c('Address', 'street', { eg: 'Road No 1, Sample Area' }),
      c('Area', 'area', { eg: 'Kukatpally' }),
      c('City / State', 'state', { help: 'Write the STATE here. Decides CGST+SGST or IGST on the invoice.', eg: 'Telangana' }),
      c('Pincode', 'pincode', { eg: '500072' }),
      c('Country', 'country', { eg: 'India' }),
      c('GST Number', 'gst', { eg: '36BBBBB0000B1Z5' }),
      c('PAN', 'pan', { eg: 'BBBBB0000B' }),
      c('TAN', 'tan'),
      c('Business Type', 'businessType', { t: 'list', list: 'businessType', eg: 'Private Limited' }),
      c('GST %', 'gstPercent', { t: 'number', help: 'Blank keeps the client\'s current rate (18% for a new client).', eg: '18' }),
      c('TDS %', 'tdsPercent', { t: 'number', help: 'Blank keeps the client\'s current rate (10% for a new client).', eg: '10' }),
      c('Payment Terms', 'paymentTerms', { eg: 'Invoice 6 days after joining; payment due within 6 days of invoice' }),
      c('Guarantee Period', 'guaranteePeriod', { eg: '3 Months' }),
      c('Commercial Notes', 'commercialNotes'),
      c('City', 'location', { help: 'Client address on invoices.', eg: 'Hyderabad' }),
      c('Client Code', 'clientCode', { help: 'Your own client number. Unique.', eg: 'CL-0001' }),
      // NOT required by the parser even though the Field Guide marks it so: a
      // blank keeps the client's current fee (8.33% for a new client) rather
      // than refusing every client row that has not been priced yet.
      c('Fee %', 'agreementFeePercent', { t: 'number', help: 'Placement fee = offered annual CTC × this %. Blank keeps the current fee (8.33% for a new client).', eg: '8.33' }),
      c('Invoice Trigger', 'invoiceTrigger', { t: 'list', list: 'invoiceTrigger', eg: 'Candidate Joining' }),
      c('Payment Due', 'paymentDue', { eg: '6 days after invoice' }),
      c('Agreement Status', 'agreementStatus', { t: 'list', list: 'agreementStatus', help: 'Only ACTIVE lets new requirements for this client go live.', eg: 'ACTIVE' }),
      c('Agreement Start', 'agreementStart', { t: 'date', eg: '01-04-2025' }),
      c('Agreement End', 'agreementEnd', { t: 'date', eg: '31-03-2027' }),
      c('Agreement Template', 'agreementTemplate', { t: 'list', list: 'agreementTemplate', eg: 'Standard Recruitment / Staffing' }),
      c('BDE Owner', 'bdeOwner', { help: 'Full name as on the Employees sheet.', eg: 'Sample Person Three' }),
      c('Account Manager', 'accountManager', { help: 'Full name as on the Employees sheet.', eg: 'Sample Person One' }),
      c('Billing Contact Name', 'billingContactName', { eg: 'Sample Accounts Head' }),
      c('Billing Contact Email', 'billingContactEmail', { eg: 'accounts@hospital.example' }),
      c('Billing Contact Phone', 'billingContactPhone', { eg: '9000000103' }),
      c('Recruitment Contact Name', 'recruitmentContactName'),
      c('Recruitment Contact Email', 'recruitmentContactEmail'),
      c('Recruitment Contact Phone', 'recruitmentContactPhone'),
      c('Primary Contact WhatsApp', 'contactWhatsApp', { eg: '9000000101' }),
      c('Risk Flag', 'riskFlag', { t: 'list', list: 'riskFlag', eg: 'None' }),
    ],
  },
  {
    name: 'Requirements',
    product: 'ATS',
    model: 'requirement',
    key: ['reqCode'],
    title: 'Job requirements (ATS)',
    lookups: { clientId: { sheet: 'Clients', by: 'name', from: 'Client Name' } },
    note: 'Requirement Code is the key, and the Applications sheet refers to a requirement by it — so give every row one. Client Name must already appear on the Clients sheet.',
    columns: [
      c('Requirement Code', 'reqCode', { req: true, help: 'Unique. Your own numbering.', eg: 'MED-0001' }),
      c('Job Title', 'title', { req: true, eg: 'Staff Nurse' }),
      c('Client Name', '_client', { req: true, help: 'Must match the Clients sheet exactly.', eg: 'Sample Hospital, Hyderabad' }),
      c('Department', 'department', { req: true, help: 'Must match the Departments sheet.', eg: 'Medical' }),
      c('Specialisation', 'specialisation', { help: 'Must match the Specialisations sheet for that department.', eg: '' }),
      c('Status', 'status', { t: 'list', list: 'requirementStatus', eg: 'OPEN' }),
      c('Priority', 'priority', { t: 'list', list: 'priority', eg: 'High' }),
      c('Openings', 'openings', { t: 'number', eg: '5' }),
      c('Hiring Type', 'hiringType', { t: 'list', list: 'hiringType', eg: 'Client Placement' }),
      // NOT REQUIRED, deliberately. Skills are what candidate matching scores
      // against, so a blank one costs you matching on that requirement — but a
      // real requirement sheet often records the QUALIFICATION and the
      // specialisation instead, and inventing a skills list to satisfy a
      // validator would put fabricated criteria into the matcher. Blank and
      // honest beats filled and wrong.
      c('Mandatory Skills', 'skills', { help: 'Comma separated. Drives candidate matching — leave blank rather than guessing.', eg: 'GNM, ICU experience' }),
      c('Good To Have Skills', 'goodToHaveSkills', { help: 'Comma separated.', eg: '' }),
      c('Experience Required', 'experience', { help: 'A range in years.', eg: '1-3' }),
      c('Education', 'education', { eg: 'Other' }),
      c('Employment Type', 'employmentType', { t: 'list', list: 'employmentTypeReq', eg: 'Full Time' }),
      c('Work Mode', 'workMode', { t: 'list', list: 'workMode', eg: 'Work From Office' }),
      c('Location', 'location', { eg: 'Hyderabad' }),
      c('Salary Band', 'salary', { help: 'As you want it displayed.', eg: '₹2.4L - ₹3.6L' }),
      c('Currency', 'currency', { eg: 'INR' }),
      c('Assigned Recruiter', '_recruiter', { help: 'Full name as on the Employees sheet. The job appears in this recruiter\'s worklist.', eg: 'Sample Person Two' }),
      c('Assigned BDE', '_bde', { help: 'Full name of the BDE who owns the client relationship for it.', eg: 'Sample Person Three' }),
      c('Assigned TL', 'tl', { help: 'Full name, must be an employee on the Employees sheet.', eg: 'Sample Person One' }),
      c('Assigned STL', 'stl', { help: 'Full name.', eg: '' }),
      c('Account Manager', 'accountManager', { eg: '' }),
      c('Closing Date', 'closingDate', { t: 'date', eg: '31-10-2026' }),
      c('Target Date', 'targetDate', { t: 'date' }),
      c('Notice Period Max', 'noticePeriodMax', { eg: '30 Days' }),
      c('Joining Timeline', 'joiningTimeline', { eg: 'Within 15 Days' }),
      c('Job Description', 'jobDescription'),
      c('Responsibilities', 'responsibilities'),
      c('Qualifications', 'qualifications'),
      c('Seat Code', '_seat', { help: 'A Seat Code from the Positions sheet — the seat that owns this job.', eg: 'MED-1' }),
      c('Additional Recruiters', '_moreRecruiters', { help: 'Comma separated full names.', eg: '' }),
      c('Preferred Location', 'preferredLocation', { eg: 'Any' }),
      c('Relevant Experience', 'relevantExperience', { help: 'Years, e.g. 1-2.', eg: '1' }),
      c('Salary Type', 'salaryType', { t: 'list', list: 'salaryType', eg: 'Annual CTC' }),
      c('Job Preference', 'jobPreference', { t: 'list', list: 'jobPreference', eg: 'Permanent' }),
    ],
  },
  {
    name: 'Candidates',
    product: 'ATS',
    model: 'candidate',
    key: ['email', 'phone'],
    title: 'Candidates (ATS)',
    note: 'Email is the key; with no email, Phone is used; with neither, External Ref. One of the three is needed, otherwise the same person imports twice on the next run. Do NOT put pipeline stage here — that belongs on the Applications sheet, because a candidate can be in more than one pipeline.',
    columns: [
      c('Full Name', 'name', { req: true, eg: 'Sample Candidate A' }),
      c('Email', 'email', { help: 'The key. Required unless Phone is given.', eg: 'cand.a@mail.example' }),
      c('Phone', 'phone', { help: 'Used as the key when there is no email.', eg: '9000000201' }),
      // THE THIRD WAY TO TELL CANDIDATES APART, for sources that record
      // neither. Several of the real recruitment sheets have no contact
      // column at all — a name, a qualification, a branch and nothing else —
      // and 12,033 rows of genuine interview history were refused because
      // of it. Keyed on name alone two people called Priyanka become one;
      // with a reference built from the fields the sheet DOES carry, they
      // stay two.
      c('External Ref', 'externalRef', { help: 'Only for candidates with no email and no phone: any stable id from your own system or sheet. Leave blank otherwise.' }),
      c('Date of Birth', 'dob', { t: 'date', eg: '12-03-1998' }),
      c('Gender', 'gender', { t: 'list', list: 'gender', eg: 'Female' }),
      c('Current Location', 'location', { eg: 'Hyderabad' }),
      c('Preferred Location', 'preferredLocation', { eg: 'Hyderabad' }),
      c('Current Company', 'currentCompany', { eg: 'Sample Clinic' }),
      c('Current Designation', 'currentDesignation', { eg: 'Staff Nurse' }),
      c('Total Experience (years)', 'experienceYears', { t: 'number', eg: '2' }),
      c('Relevant Experience (years)', 'relevantExperienceYears', { t: 'number', eg: '2' }),
      c('Current Salary', 'currentSalary', { eg: '2.4 LPA' }),
      c('Expected Salary', 'expectedSalary', { eg: '3 LPA' }),
      c('Notice Period', 'noticePeriod', { eg: '30 Days' }),
      c('Education', 'education', { eg: 'B.Sc Nursing' }),
      c('Specialisation', 'specialization', { help: 'For Medical and similar: MBBS, Dermatology, Gynaecology …', eg: '' }),
      c('Institute', 'institute', { eg: 'Sample Nursing College' }),
      c('Passing Year', 'passingYear', { eg: '2020' }),
      c('Mandatory Skills', 'skills', { help: 'Comma separated. Scored against the requirement.', eg: 'ICU, Patient care' }),
      c('Good To Have Skills', 'goodToHaveSkills', { help: 'Comma separated.' }),
      c('Technical Skills', 'technicalSkills', { help: 'Comma separated.' }),
      c('Soft Skills', 'softSkills', { help: 'Comma separated.' }),
      c('Source', 'source', { help: 'Where they came from.', eg: 'Naukri' }),
      c('Source Campaign', 'sourceCampaign'),
      c('Resume File Name', 'resumeName', { help: 'Just the file name. Resumes are uploaded separately on the candidate screen.', eg: 'cand-a.pdf' }),
      c('Availability', 'availability', { t: 'list', list: 'availability', eg: 'Available after notice period' }),
      c('Preferred Work Mode', 'preferredWorkMode', { t: 'list', list: 'candidateWorkMode', eg: 'Work From Office' }),
      c('Preferred Employment Type', 'preferredEmploymentType', { t: 'list', list: 'candidateEmploymentType', eg: 'Full Time' }),
      c('Job Preference', 'jobPreference', { t: 'list', list: 'candidateJobPreference', eg: 'Permanent' }),
    ],
  },
  {
    name: 'Applications',
    product: 'ATS',
    model: 'application',
    key: ['_candidate', '_requirement'],
    title: 'Applications — which candidate is in which pipeline, and where',
    note: 'THIS SHEET IS THE PIPELINE. One row per candidate-per-requirement: the same candidate can appear on several requirements, each at its own stage. Candidate and Requirement must already appear on their own sheets. Stage must be one of the codes in the dropdown — that is what drives the pipeline board. A REJECTED row needs Rejected By and a reason (category or detail), exactly as the Reject dialog does. Interview and offer detail now have their own sheets (Interviews, Joinings).',
    columns: [
      c('Candidate Email or Phone', '_candidate', { req: true, help: 'Whatever identifies them on the Candidates sheet — their email, their phone, or their External Ref where the source records neither.', eg: 'cand.a@mail.example' }),
      c('Requirement Code', '_requirement', { req: true, help: 'Must match a row on the Requirements sheet.', eg: 'MED-0001' }),
      c('Stage', 'stage', { req: true, t: 'list', list: 'stage', help: 'Where this candidate currently sits in the pipeline.', eg: 'JOINED' }),
      c('Stage Date', '_stageDate', { t: 'date', help: 'When they reached this stage — ageing and follow-up reports count from it.', eg: '05-09-2026' }),
      c('Source', 'source', { eg: 'Naukri' }),
      c('Match Score', 'matchScore', { t: 'number', help: '0-100. Leave blank to let the system compute it.', eg: '' }),
      c('Rejection Reason', 'rejectionReason', { help: 'The detailed reason. A REJECTED row needs this or a Rejection Category.', eg: '' }),
      c('Rejected By', '_rejectedBy', { t: 'list', list: 'rejectedBy', help: 'Whose decision the rejection was. Required when Stage is REJECTED.', eg: '' }),
      c('Rejection Category', '_rejectionCategory', { help: 'One of the reasons for that side (as on the Reject dialog).', eg: '' }),
      // The interview and offer columns this sheet used to carry. The current
      // workbook moved them to the Interviews and Joinings sheets; an older
      // file that still has them keeps importing them.
      c('Interview Date/Time', 'interviewAt', { t: 'date', legacy: true }),
      c('Interview Round', 'interviewRound', { t: 'number', legacy: true }),
      c('Interview Mode', 'interviewMode', { t: 'list', list: 'interviewMode', legacy: true }),
      c('Interviewer', 'interviewer', { legacy: true }),
      c('Interview Result', 'interviewResult', { t: 'list', list: 'interviewResult', legacy: true }),
      c('Interview Feedback', 'interviewFeedback', { legacy: true }),
      c('Offer Status', 'offerStatus', { t: 'list', list: 'offerStatus', legacy: true }),
      c('Offered CTC', 'offeredCtc', { t: 'number', legacy: true }),
      c('Offer Date', 'offerDate', { t: 'date', legacy: true }),
      c('Joining Date', 'joiningDate', { t: 'date', legacy: true }),
    ],
  },
  {
    name: 'Interviews',
    product: 'ATS',
    model: 'interview',
    key: ['_candidate', '_requirement', 'interviewRound'],
    title: 'Interviews and their feedback',
    note: 'Candidate + Requirement + Round is the key, and the candidate must already have a row on the Applications sheet for that requirement. The latest round is what the interview calendar shows; earlier rounds are kept in the interview history. Feedback By + scores record the Internal or Client feedback (one of each per application).',
    columns: [
      c('Candidate Email or Phone', '_candidate', { req: true, eg: '9000000202' }),
      c('Requirement Code', '_requirement', { req: true, eg: 'EDU-0001' }),
      c('Interview Round', 'interviewRound', { t: 'number', help: '1, 2, 3 … Blank = 1.', eg: '1' }),
      c('Interview Type', 'interviewType', { t: 'list', list: 'interviewType', eg: 'Client Interview' }),
      c('Interview Date', '_date', { req: true, t: 'date', eg: '26-09-2026' }),
      c('Interview Time', '_time', { t: 'time', help: 'HH:MM, 24-hour.', eg: '11:00' }),
      c('Interview Mode', 'interviewMode', { t: 'list', list: 'interviewMode', eg: 'In Person' }),
      c('Interviewer', 'interviewer', { eg: 'Sample Principal' }),
      c('Location', 'interviewLocation', { eg: 'College campus, Ghatkesar' }),
      c('Meeting Link', 'interviewMeetingLink', { eg: '' }),
      c('Interview Status', 'interviewStatus', { t: 'list', list: 'interviewStatus', eg: 'SCHEDULED' }),
      c('Interview Result', 'interviewResult', { t: 'list', list: 'interviewResult', eg: '' }),
      c('Feedback By', '_feedbackBy', { t: 'list', list: 'feedbackBy', eg: '' }),
      c('Technical (1-5)', '_technical', { t: 'number', eg: '' }),
      c('Communication (1-5)', '_communication', { t: 'number', eg: '' }),
      c('Experience (1-5)', '_experience', { t: 'number', eg: '' }),
      c('Role Fit (1-5)', '_roleFit', { t: 'number', eg: '' }),
      c('Feedback Comments', '_comments', { eg: '' }),
    ],
  },

  // --- 4. Accounts ---------------------------------------------------------
  {
    name: 'Invoices',
    product: 'Accounts',
    model: 'invoice',
    key: ['invoiceNumber'],
    title: 'Invoices (Accounts)',
    note: 'Invoice Number is the key. Client Name must appear on the Clients sheet; Candidate and Requirement are optional but link the invoice to the placement it was raised for. Amount is the fee BEFORE GST and TDS. Record money received EITHER as Received Amount here OR as rows on the Payments sheet — a Payments row that is already counted in Received Amount is itemised, never counted twice.',
    lookups: { clientId: { sheet: 'Clients', by: 'name', from: 'Client Name' } },
    columns: [
      c('Invoice Number', 'invoiceNumber', { req: true, help: 'Unique.', eg: 'INV-EX-001' }),
      c('Client Name', '_client', { req: true, eg: 'Sample Hospital, Hyderabad' }),
      c('Candidate Email or Phone', '_candidate', { help: 'The placement this invoice is for — email, phone or External Ref.', eg: 'cand.a@mail.example' }),
      c('Requirement Code', '_requirement', { eg: 'MED-0001' }),
      c('Invoice Date', 'invoiceDate', { req: true, t: 'date', eg: '15-09-2026' }),
      c('Due Date', 'dueDate', { t: 'date', eg: '21-09-2026' }),
      c('Amount', 'amount', { req: true, t: 'number', help: 'The fee, before GST and TDS.', eg: '24990' }),
      c('GST %', 'gstPercent', { t: 'number', eg: '18' }),
      c('TDS %', 'tdsPercent', { t: 'number', eg: '10' }),
      c('Status', 'status', { t: 'list', list: 'invoiceStatus', eg: 'Paid' }),
      c('Received Amount', 'receivedAmount', { t: 'number', help: 'Money actually received (after TDS). Or list each receipt on the Payments sheet instead.', eg: '26990' }),
      c('Paid Date', 'paidDate', { t: 'date' }),
      c('Bank Transaction Ref', 'bankTxnId'),
      c('Fee %', 'feePercent', { t: 'number', help: 'Your fee as a percentage of the candidate CTC.', eg: '8.33' }),
      c('Offered CTC', 'offeredCtc', { t: 'number', eg: '300000' }),
      c('Joining Date', 'joiningDate', { t: 'date' }),
      c('Payment Terms', 'paymentTerms'),
      c('TDS Certificate Received', 'tdsCertReceived', { t: 'list', list: 'yesNo' }),
      c('TDS Certificate Ref', 'tdsCertRef'),
      c('Notes', 'notes'),
      c('Sent Via', 'sentVia', { t: 'list', list: 'sentVia', eg: 'Email' }),
      c('Sent Date', 'sentDate', { t: 'date', eg: '15-09-2026' }),
      c('TDS Certificate Date', 'tdsCertDate', { t: 'date' }),
    ],
  },
  {
    // AFTER Invoices, not before: a joining links to its invoice by number,
    // and that invoice may be one the Invoices sheet creates in this upload.
    name: 'Joinings',
    product: 'ATS',
    model: 'joining',
    key: ['_candidate', '_requirement'],
    title: 'Offers and joinings',
    note: 'Candidate + Requirement is the key; the candidate must already have a row on the Applications sheet for that requirement. IMPORTING A JOINING NEVER RAISES AN INVOICE and never creates an HRMS employee — it records what happened. To link the joining to its invoice, give the Invoice Number of an invoice on the Invoices sheet (or already in the app).',
    columns: [
      c('Candidate Email or Phone', '_candidate', { req: true, eg: 'cand.a@mail.example' }),
      c('Requirement Code', '_requirement', { req: true, eg: 'MED-0001' }),
      c('Hiring Type', 'hiringType', { t: 'list', list: 'hiringType', eg: 'Client Placement' }),
      c('Offer Status', 'offerStatus', { t: 'list', list: 'offerStatus', eg: 'Offer Accepted' }),
      c('Offer Date', 'offerDate', { t: 'date', eg: '01-09-2026' }),
      c('Offered CTC (annual ₹)', 'offeredCtc', { req: true, t: 'number', eg: '300000' }),
      c('Joining Date', 'joiningDate', { t: 'date', help: 'Required when Joining Status is Joined.', eg: '10-09-2026' }),
      c('Joining Status', 'joiningStatus', { t: 'list', list: 'joiningStatus', eg: 'Joined' }),
      c('Documents Status', 'documentsStatus', { t: 'list', list: 'documentsStatus', eg: 'Verified' }),
      ns('Fee % (if different)', 'there is no per-placement fee column on the joining. The fee actually billed is the invoice\'s own Fee % (Invoices sheet) or, when the app raises the invoice, the client\'s Fee %', { t: 'number' }),
      c('Invoice Number', '_invoice', { help: 'An Invoice Number from the Invoices sheet.', eg: 'INV-EX-001' }),
    ],
  },
  {
    name: 'Payments',
    product: 'Accounts',
    model: 'payment',
    key: ['_invoice', 'date', 'amount', 'reference'],
    title: 'Money received against invoices',
    note: 'One row per receipt. Invoice Number + Received Date + Amount + Reference is the key, so re-importing does not record a receipt twice. Each receipt settles the invoice the same way Record Payment does (Partially Paid → Paid).',
    columns: [
      c('Invoice Number', '_invoice', { req: true, eg: 'INV-EX-001' }),
      c('Received Date', 'date', { req: true, t: 'date', eg: '20-09-2026' }),
      c('Amount Received', 'amount', { req: true, t: 'number', eg: '26990' }),
      c('Method', 'method', { t: 'list', list: 'paymentMethod', eg: 'Bank Transfer' }),
      c('Reference / UTR', 'reference', { eg: 'UTR0000000001' }),
      c('Notes', 'notes', { eg: '' }),
    ],
  },
  {
    name: 'Bank Accounts',
    product: 'Accounts',
    model: 'bankAccount',
    key: ['accNo'],
    title: 'Bank accounts and credit cards',
    note: 'Account Number is the key (last 4 digits for a card). With no account number, Bank Name + Account Name is. An account already in the app with the same Bank Name and no account number yet is completed rather than duplicated.',
    columns: [
      c('Bank Name', 'bank', { req: true, eg: 'Sample Bank' }),
      c('Account Name', 'name', { eg: 'Sample Staffing Consultants' }),
      c('Account Number', 'accNo', { eg: '000000000000' }),
      c('IFSC', 'ifsc', { eg: 'SAMP0000001' }),
      c('Branch', 'branch', { eg: 'Madhapur' }),
      c('Opening Balance', 'openBal', { req: true, t: 'number', help: 'Minus for a card amount owed.', eg: '250000' }),
      c('Opening Balance Date', 'openDate', { req: true, t: 'date', eg: '01-04-2026' }),
      c('Active', '_active', { t: 'list', list: 'yesNo', eg: 'Yes' }),
    ],
  },
  {
    // THERE IS NO VENDOR TABLE. The app knows a vendor through the bills filed
    // against it and through the bank's remembered narrations. The one thing
    // on this sheet the app can keep is what a vendor's payments are FILED AS:
    // a remembered-narration rule (Bank & Reconciliation → Rules) matching the
    // vendor's name, with its default category and GST rate. The rest is
    // reported as not stored.
    name: 'Vendors',
    product: 'Accounts',
    model: 'vendor',
    key: ['name'],
    title: 'Vendors',
    note: 'Vendor Name is the key. Kept as a Bank & Reconciliation rule: a bank line whose narration names this vendor is suggested as its Default Category and GST %. Rows with no Default Category have nothing the app can keep yet.',
    columns: [
      c('Vendor Name', 'name', { req: true, eg: 'Sample Workspaces LLP' }),
      ns('Vendor GSTIN', 'the app has no vendor master yet; a bill carries its own Vendor GSTIN (Office Expenses sheet)'),
      ns('Vendor State', 'the app has no vendor master yet; a bill carries its own Vendor State'),
      ns('GST Treatment', 'the app has no vendor master yet; a bill carries its own GST Treatment'),
      ns('Supply Type', 'the app has no vendor master yet; a bill carries its own Supply Type'),
      c('Default Category', 'category', { eg: 'Office Rent' }),
      c('Default GST %', 'gstRate', { t: 'number', eg: '18' }),
      ns('Default TDS %', 'the app has no vendor master yet; a bill carries its own TDS %', { t: 'number' }),
      ns('Notes', 'the app has no vendor master yet'),
    ],
  },
  {
    name: 'HR Policy',
    product: 'HRMS',
    model: 'hrPolicy',
    kv: true,
    key: ['Setting'],
    title: 'HR policy settings',
    note: 'One row per setting. Fill "Your value" only for what you want to change; a blank leaves the app\'s current value.',
    columns: [
      c('Setting (do not change)', 'setting', { req: true, label: true }),
      c('Your value', 'value', { t: 'any' }),
    ],
  },
];

// ---------------------------------------------------------------------------
// ATS MODULE IMPORTS (hrms-25 "ATS lo prathi module lo export & import").
//
// Each ATS screen's Import button reads ONE sheet, not the whole workbook, and
// is run by routes/atsIo.js on top of the SAME row reader and the SAME
// per-sheet handlers routes/dataImport.js uses. These are that one-sheet
// view of the definitions above: a kind names the sheet it borrows from and
// the columns it keeps, so a header can never be spelled one way here and
// another there. The three that have no sheet above (Agreements is the
// Clients sheet's agreement columns; Requirement Assignments and Follow-ups
// are new) are defined here, once.
//
// Not part of SHEETS on purpose: the master Data Import workbook is unchanged.
// ---------------------------------------------------------------------------
LISTS.contactMode = ['Call', 'Email', 'WhatsApp', 'SMS', 'In Person', 'Video Call'];
LISTS.assignmentRole = ['Primary', 'Co-recruiter'];

const sheetNamed = (name) => SHEETS.find((s) => s.name === name);
// The columns of `from` with these headers, in THIS order, with overrides
// (e.g. { 'Offered CTC (annual ₹)': { req: false } }).
function borrow(from, headers, overrides = {}) {
  const src = sheetNamed(from);
  return headers.map((h) => {
    const col = src.columns.find((x) => x.h === h);
    if (!col) throw new Error(`importSpec: sheet ${from} has no column "${h}"`);
    return { ...col, ...(overrides[h] || {}) };
  });
}

const ATS_IMPORT_SHEETS = {
  clients: { ...sheetNamed('Clients'), columns: sheetNamed('Clients').columns.filter((x) => !x.legacy) },
  agreements: {
    name: 'Agreements',
    product: 'ATS',
    model: 'client',
    key: ['name'],
    title: 'Agreement status, fee and dates for clients already on file',
    note: 'Updates the agreement fields of EXISTING clients, matched by Client Name (case and punctuation ignored). A client not on file is reported, never created. A blank cell keeps the current value.',
    columns: borrow('Clients', [
      'Client Name', 'Agreement Status', 'Agreement Start', 'Agreement End', 'Agreement Template',
      'Fee %', 'Invoice Trigger', 'Payment Due', 'Payment Terms', 'Guarantee Period',
    ]),
  },
  requirements: { ...sheetNamed('Requirements'), columns: sheetNamed('Requirements').columns.filter((x) => !x.legacy) },
  candidates: {
    ...sheetNamed('Candidates'),
    // Two optional columns put the candidate straight onto a pipeline — the
    // Applications sheet's own two, so the rule for them is that sheet's.
    columns: [
      ...sheetNamed('Candidates').columns.filter((x) => !x.legacy),
      { ...borrow('Applications', ['Requirement Code'])[0], req: false, help: 'Optional: also add the candidate to this requirement\'s pipeline.' },
      // `_stage`, not `stage`: a Candidate has no stage (that is the whole
      // point of the Applications sheet), so it must never reach pick().
      { ...borrow('Applications', ['Stage'])[0], f: '_stage', req: false, help: 'Stage on that pipeline. Blank = NEW.' },
    ],
  },
  applications: { ...sheetNamed('Applications'), columns: sheetNamed('Applications').columns.filter((x) => !x.legacy) },
  interviews: { ...sheetNamed('Interviews') },
  'interview-feedback': {
    ...sheetNamed('Interviews'),
    name: 'Interview Feedback',
    title: 'Interview outcomes and feedback',
    note: 'Candidate + Requirement + Round is the key; the interview must already be on the application. Interview Date may be left blank — the scheduled date is kept.',
    columns: borrow('Interviews', [
      'Candidate Email or Phone', 'Requirement Code', 'Interview Round', 'Interview Date', 'Interview Status',
      'Interview Result', 'Feedback By', 'Technical (1-5)', 'Communication (1-5)', 'Experience (1-5)',
      'Role Fit (1-5)', 'Feedback Comments',
    ], { 'Interview Date': { req: false, help: 'Blank keeps the scheduled date.' } }),
  },
  offers: {
    ...sheetNamed('Joinings'),
    name: 'Offers',
    title: 'Offers',
    note: 'Candidate + Requirement is the key; the application must already exist. Updates the offer on it — never raises an invoice.',
    columns: borrow('Joinings', [
      'Candidate Email or Phone', 'Requirement Code', 'Offer Status', 'Offer Date', 'Offered CTC (annual ₹)', 'Documents Status',
    ], { 'Offered CTC (annual ₹)': { req: false, help: 'Needed once when an offer is released, if the application has none yet.' } }),
  },
  joining: {
    ...sheetNamed('Joinings'),
    name: 'Joining',
    title: 'Joining dates and statuses',
    note: 'Candidate + Requirement is the key; the application must already exist. Records the joining — never raises an invoice and never creates an employee.',
    columns: borrow('Joinings', [
      'Candidate Email or Phone', 'Requirement Code', 'Joining Date', 'Joining Status', 'Documents Status', 'Offered CTC (annual ₹)',
    ], { 'Offered CTC (annual ₹)': { req: false } }),
  },
  'internal-hiring': {
    ...sheetNamed('Joinings'),
    name: 'Internal Hiring',
    title: 'TeamLink internal hires',
    note: 'Candidate + Requirement is the key; the requirement must be a TeamLink internal opening. Records the offer / joining — the HRMS employee is still created from the Internal Hiring screen.',
    columns: borrow('Joinings', [
      'Candidate Email or Phone', 'Requirement Code', 'Offer Status', 'Offer Date', 'Offered CTC (annual ₹)',
      'Joining Date', 'Joining Status', 'Documents Status',
    ], { 'Offered CTC (annual ₹)': { req: false } }),
  },
  'requirement-assignments': {
    name: 'Requirement Assignments',
    product: 'ATS',
    model: 'requirementAssignment',
    key: ['_requirement', '_recruiter'],
    title: 'Which recruiter works which requirement',
    note: 'Requirement Code + Recruiter is the key. The recruiter is named by Employee Code or login email. Primary makes them the requirement\'s recruiter; Co-recruiter adds them beside whoever holds it. A pair already in place is skipped.',
    columns: [
      c('Requirement Code', '_requirement', { req: true, eg: 'MED-0001' }),
      c('Recruiter (Employee Code or Email)', '_recruiter', { req: true, help: 'Their Employee Code (e.g. TL474) or their login email.', eg: 'TL474' }),
      c('Assign As', '_as', { t: 'list', list: 'assignmentRole', help: 'Blank = Primary.', eg: 'Primary' }),
    ],
  },
  followups: {
    name: 'Follow-ups',
    product: 'ATS',
    model: 'followUp',
    key: ['_candidate', '_requirement', 'nextAction', 'dueDate'],
    title: 'Follow-ups on candidates in a pipeline',
    note: 'Candidate + Requirement names the application, which must already exist. Each row records a follow-up exactly as the Follow-up dialog does (the open one on that application is closed first). The same Next Action + Due Date already open is skipped.',
    columns: [
      c('Candidate Email or Phone', '_candidate', { req: true, eg: 'cand.a@mail.example' }),
      c('Requirement Code', '_requirement', { req: true, eg: 'MED-0001' }),
      c('Next Action', 'nextAction', { help: 'What is owed next. Blank = the stage\'s usual next step.', eg: 'Confirm interview slot' }),
      c('Due Date', 'dueDate', { t: 'date', help: 'Blank = the stage\'s usual due date.', eg: '30-09-2026' }),
      c('Next Follow-up Date', 'nextFollowUpAt', { t: 'date' }),
      c('Contact Mode', 'contactMode', { t: 'list', list: 'contactMode', eg: 'Call' }),
      c('Contacted On', 'lastContactedAt', { t: 'date', help: 'When the contact happened. Blank = today.' }),
      c('Notes', 'notes'),
    ],
  },
};

module.exports = {
  SHEETS, LISTS, REJECTION_REASONS_BY_SIDE, HR_POLICY_SETTINGS, IMPORTED_ELSEWHERE, REFERENCE_SHEETS,
  ATS_IMPORT_SHEETS,
};

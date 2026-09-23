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
// DATES ARE ALWAYS YYYY-MM-DD. Excel will happily hand over a serial number, a
// string or a Date depending on how the cell was typed; the importer coerces
// all three, and the template sets the column format so what the user sees
// matches what they typed.
// ---------------------------------------------------------------------------

const { ALL_STAGE_CODES } = require('./atsVocab');

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
  clientStatus: ['Active', 'Inactive', 'Suspended'],
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
};

// A column: `h` header, `f` model field, `req` required, `t` type,
// `list` allowed values, `help` the note under the header, `eg` the example.
const c = (h, f, opts = {}) => ({ h, f, t: 'text', ...opts });

// ---------------------------------------------------------------------------
// THE SHEETS, IN IMPORT ORDER.
// ---------------------------------------------------------------------------
const SHEETS = [
  // --- 1. Organisation -----------------------------------------------------
  {
    name: 'Departments',
    product: 'Setup',
    model: 'department',
    key: ['name'],
    title: 'Departments and their teams',
    note: 'FILL THIS FIRST. Every other sheet refers to a department by this name, so a typo here becomes a missing link later. One row per TEAM; repeat the department name for each of its teams. A department with no teams yet: leave Team blank.',
    columns: [
      c('Department', 'name', { req: true, help: 'Medical, IT, Manufacturing, Educational, BDE, Accounts, HR …', eg: 'Medical' }),
      c('Team', 'team', { help: 'A team inside that department. Blank if the department has no teams.', eg: 'Medical Team-A' }),
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
      c('Employee Code', 'employeeCode', { req: true, help: 'Unique. Your own numbering — TL001, EMP-1042, anything consistent.', eg: 'TLE001' }),
      c('Full Name', 'name', { req: true, eg: 'Anjali Verma' }),
      c('Official Email', 'email', { help: 'Also used as the login email unless Login Email is filled.', eg: 'anjali.verma@yourcompany.com' }),
      c('Phone', 'phone', { eg: '9876543210' }),
      c('Department', 'department', { req: true, help: 'Must match the Departments sheet.', eg: 'Medical' }),
      c('Team', 'team', { help: 'Must match a team of that department.', eg: 'Medical Team-A' }),
      c('Designation', 'designation', { req: true, t: 'list', list: 'designation', help: 'Decides their roles and which products they see.', eg: 'Employee' }),
      c('Reporting TL', 'tl', { help: 'Full name of their TL. Leave blank for a TL or above.', eg: 'Divya Rao' }),
      c('Reporting STL', 'stl', { help: 'Full name of their STL.', eg: 'Ganesh Iyer' }),
      c('Date of Joining', 'dateOfJoining', { t: 'date', eg: '2024-06-01' }),
      c('Employment Status', 'employmentStatus', { t: 'list', list: 'employmentStatus', eg: 'Active' }),
      c('Employee Type', 'employeeType', { t: 'list', list: 'employeeType', eg: 'Full-time' }),
      c('Experience', 'employmentExperience', { t: 'list', list: 'experience', eg: 'Experienced' }),
      c('Branch / Office', 'branch', { eg: 'Hyderabad' }),
      c('Work Location', 'location', { eg: 'Hyderabad' }),
      c('Date of Birth', 'dateOfBirth', { t: 'date', eg: '1995-03-14' }),
      c('Gender', 'gender', { t: 'list', list: 'gender', eg: 'Female' }),
      c('Blood Group', 'bloodGroup', { eg: 'O+' }),
      c('Address Line 1', 'addressLine1', { eg: '12-4-78, Green Meadows' }),
      c('Address Line 2', 'addressLine2'),
      c('City', 'city', { eg: 'Hyderabad' }),
      c('District', 'district', { eg: 'Rangareddy' }),
      c('State', 'state', { eg: 'Telangana' }),
      c('Postal Code', 'postalCode', { eg: '500032' }),
      c('Country', 'country', { eg: 'India' }),
      c('Emergency Contact Name', 'emergencyContactName', { eg: 'Ramesh Verma' }),
      c('Emergency Contact Phone', 'emergencyContactPhone', { eg: '9876500011' }),
      c('Emergency Contact Relation', 'emergencyContactRelation', { eg: 'Father' }),
      c('Education', 'educationDetails', { eg: 'B.Tech, JNTU Hyderabad, 2017' }),
      c('Skills', 'skills', { help: 'Comma separated.', eg: 'Sourcing, Screening, Naukri' }),
      c('Shift', 'shift', { eg: 'General (9:00 AM – 6:00 PM)' }),
      c('Bank Name', 'bankName', { eg: 'HDFC Bank' }),
      c('Bank Account Number', 'bankAccountNumber', { eg: '50100123456789' }),
      c('IFSC Code', 'ifscCode', { eg: 'HDFC0001234' }),
      c('PAN', 'panNumber', { eg: 'ABCDE1234F' }),
      c('Aadhaar', 'aadhaarNumber', { eg: '1234 5678 9012' }),
      c('UAN', 'uanNumber', { eg: '100123456789' }),
      c('PF Number', 'pfNumber'),
      c('ESI Number', 'esiNumber'),
      c('Create Login', '_createLogin', { t: 'list', list: 'yesNo', help: 'Yes creates a login for this person. They get a first-time password you can reset from Administration → Users.', eg: 'Yes' }),
      c('Login Email', '_loginEmail', { help: 'Only if it differs from Official Email.', eg: '' }),
    ],
  },

  // --- 3. ATS --------------------------------------------------------------
  {
    name: 'Clients',
    product: 'ATS',
    model: 'client',
    key: ['name'],
    title: 'Client companies (ATS)',
    note: 'Client Name is the key — requirements and invoices refer to a client by this exact name, so keep it consistent. Commercial terms here are what the invoice defaults to.',
    columns: [
      c('Client Name', 'name', { req: true, help: 'The name used everywhere else in the workbook.', eg: 'Orbit Software Solutions' }),
      c('Legal Name', 'legalName', { eg: 'Orbit Software Solutions Pvt Ltd' }),
      c('Industry', 'industry', { eg: 'Information Technology' }),
      c('Client Type', 'clientType', { t: 'list', list: 'clientType', eg: 'Direct' }),
      c('Status', 'status', { t: 'list', list: 'clientStatus', eg: 'Active' }),
      c('Priority', 'priority', { t: 'list', list: 'priority', eg: 'High' }),
      c('Owning Department', 'ownerDepartment', { help: 'Which department of yours handles this client.', eg: 'IT' }),
      c('Website', 'website', { eg: 'https://orbitsoftware.example' }),
      c('Landline', 'landline', { eg: '040-23456789' }),
      c('Primary Contact Name', 'contactName', { eg: 'Sunil Rao' }),
      c('Primary Contact Designation', 'contactDesignation', { eg: 'Talent Acquisition Head' }),
      c('Primary Contact Phone', 'contactPhone', { eg: '9876512345' }),
      c('Primary Contact Email', 'contactEmail', { eg: 'sunil.rao@orbitsoftware.example' }),
      c('Secondary Contact Name', 'secondaryContactName'),
      c('Secondary Contact Phone', 'secondaryContactPhone'),
      c('Secondary Contact Email', 'secondaryContactEmail'),
      c('Address', 'street', { eg: 'Plot 42, HITEC City' }),
      c('Area', 'area', { eg: 'Madhapur' }),
      c('City / State', 'state', { eg: 'Telangana' }),
      c('Pincode', 'pincode', { eg: '500081' }),
      c('Country', 'country', { eg: 'India' }),
      c('GST Number', 'gst', { eg: '36AABCU9603R1ZX' }),
      c('PAN', 'pan', { eg: 'AABCU9603R' }),
      c('TAN', 'tan'),
      c('Business Type', 'businessType', { t: 'list', list: 'businessType', eg: 'Private Limited' }),
      c('GST %', 'gstPercent', { t: 'number', eg: '18' }),
      c('TDS %', 'tdsPercent', { t: 'number', eg: '10' }),
      c('Payment Terms', 'paymentTerms', { eg: 'Invoice 6 days after joining; payment due within 6 days of invoice' }),
      c('Guarantee Period', 'guaranteePeriod', { eg: '30 Days' }),
      c('Commercial Notes', 'commercialNotes'),
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
      c('Requirement Code', 'reqCode', { req: true, help: 'Unique. Your own numbering.', eg: 'REQ-2026-001' }),
      c('Job Title', 'title', { req: true, eg: 'Senior Java Developer' }),
      c('Client Name', '_client', { req: true, help: 'Must match the Clients sheet exactly.', eg: 'Orbit Software Solutions' }),
      c('Department', 'department', { req: true, help: 'Must match the Departments sheet.', eg: 'IT' }),
      c('Specialisation', 'specialisation', { help: 'Must match the Specialisations sheet for that department.', eg: '' }),
      c('Status', 'status', { t: 'list', list: 'requirementStatus', eg: 'OPEN' }),
      c('Priority', 'priority', { t: 'list', list: 'priority', eg: 'High' }),
      c('Openings', 'openings', { t: 'number', eg: '3' }),
      c('Hiring Type', 'hiringType', { t: 'list', list: 'hiringType', eg: 'Client Placement' }),
      // NOT REQUIRED, deliberately. Skills are what candidate matching scores
      // against, so a blank one costs you matching on that requirement — but a
      // real requirement sheet often records the QUALIFICATION and the
      // specialisation instead, and inventing a skills list to satisfy a
      // validator would put fabricated criteria into the matcher. Blank and
      // honest beats filled and wrong.
      c('Mandatory Skills', 'skills', { help: 'Comma separated. Drives candidate matching — leave blank rather than guessing.', eg: 'Java, Spring Boot, Microservices' }),
      c('Good To Have Skills', 'goodToHaveSkills', { help: 'Comma separated.', eg: 'Kafka, AWS' }),
      c('Experience Required', 'experience', { help: 'A range in years.', eg: '5-8' }),
      c('Education', 'education', { eg: 'Any Degree' }),
      c('Employment Type', 'employmentType', { t: 'list', list: 'employmentTypeReq', eg: 'Full Time' }),
      c('Work Mode', 'workMode', { t: 'list', list: 'workMode', eg: 'Hybrid' }),
      c('Location', 'location', { eg: 'Hyderabad' }),
      c('Salary Band', 'salary', { help: 'As you want it displayed.', eg: '₹14L - ₹20L' }),
      c('Currency', 'currency', { eg: 'INR' }),
      c('Assigned Recruiter', '_recruiter', { help: 'Full name of the recruiter who owns this requirement. Must be an employee with a login.', eg: 'Kiran Kumar' }),
      c('Assigned BDE', '_bde', { help: 'Full name of the BDE who owns the client relationship for it.', eg: 'Sanjay Mehta' }),
      c('Assigned TL', 'tl', { help: 'Full name, must be an employee on the Employees sheet.', eg: 'Rekha Nair' }),
      c('Assigned STL', 'stl', { help: 'Full name.', eg: 'Ganesh Iyer' }),
      c('Account Manager', 'accountManager', { eg: 'Sanjay Mehta' }),
      c('Closing Date', 'closingDate', { t: 'date', eg: '2026-11-30' }),
      c('Target Date', 'targetDate', { t: 'date' }),
      c('Notice Period Max', 'noticePeriodMax', { eg: '30 Days' }),
      c('Joining Timeline', 'joiningTimeline', { eg: 'Within 15 Days' }),
      c('Job Description', 'jobDescription'),
      c('Responsibilities', 'responsibilities'),
      c('Qualifications', 'qualifications'),
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
      c('Full Name', 'name', { req: true, eg: 'Arjun Mehta' }),
      c('Email', 'email', { help: 'The key. Required unless Phone is given.', eg: 'arjun.mehta@example.com' }),
      c('Phone', 'phone', { help: 'Used as the key when there is no email.', eg: '9812345678' }),
      // THE THIRD WAY TO TELL CANDIDATES APART, for sources that record
      // neither. Several of the real recruitment sheets have no contact
      // column at all — a name, a qualification, a branch and nothing else —
      // and 12,033 rows of genuine interview history were refused because
      // of it. Keyed on name alone two people called Priyanka become one;
      // with a reference built from the fields the sheet DOES carry, they
      // stay two.
      c('External Ref', 'externalRef', { help: 'Only for candidates with no email and no phone: any stable id from your own system or sheet. Leave blank otherwise.' }),
      c('Date of Birth', 'dob', { t: 'date', eg: '1993-08-22' }),
      c('Gender', 'gender', { t: 'list', list: 'gender', eg: 'Male' }),
      c('Current Location', 'location', { eg: 'Bengaluru' }),
      c('Preferred Location', 'preferredLocation', { eg: 'Hyderabad' }),
      c('Current Company', 'currentCompany', { eg: 'Techwave Systems' }),
      c('Current Designation', 'currentDesignation', { eg: 'Java Developer' }),
      c('Total Experience (years)', 'experienceYears', { t: 'number', eg: '6.5' }),
      c('Relevant Experience (years)', 'relevantExperienceYears', { t: 'number', eg: '5' }),
      c('Current Salary', 'currentSalary', { eg: '12 LPA' }),
      c('Expected Salary', 'expectedSalary', { eg: '18 LPA' }),
      c('Notice Period', 'noticePeriod', { eg: '30 Days' }),
      c('Education', 'education', { eg: 'B.Tech Computer Science' }),
      c('Specialisation', 'specialization', { help: 'For Medical and similar: MBBS, Dermatology, Gynaecology …', eg: '' }),
      c('Institute', 'institute', { eg: 'VIT Vellore' }),
      c('Passing Year', 'passingYear', { eg: '2016' }),
      c('Mandatory Skills', 'skills', { help: 'Comma separated. Scored against the requirement.', eg: 'Java, Spring Boot, Microservices' }),
      c('Good To Have Skills', 'goodToHaveSkills', { help: 'Comma separated.' }),
      c('Technical Skills', 'technicalSkills', { help: 'Comma separated.' }),
      c('Soft Skills', 'softSkills', { help: 'Comma separated.' }),
      c('Source', 'source', { help: 'Where they came from.', eg: 'Naukri' }),
      c('Source Campaign', 'sourceCampaign'),
      c('Resume File Name', 'resumeName', { help: 'Just the file name. Resumes are uploaded separately on the candidate screen.', eg: 'arjun-mehta-java.pdf' }),
    ],
  },
  {
    name: 'Applications',
    product: 'ATS',
    model: 'application',
    key: ['_candidate', '_requirement'],
    title: 'Applications — which candidate is in which pipeline, and where',
    note: 'THIS SHEET IS THE PIPELINE. One row per candidate-per-requirement: the same candidate can appear on several requirements, each at its own stage. Candidate and Requirement must already appear on their own sheets. Stage must be one of the codes in the dropdown — that is what drives the pipeline board. There is no Owner column on purpose: who a candidate is waiting on is WORKED OUT from the stage plus the recruiter, BDE and TL named on the requirement, so it can never disagree with them. Assign people on the Requirements sheet.',
    columns: [
      c('Candidate Email or Phone', '_candidate', { req: true, help: 'Whatever identifies them on the Candidates sheet — their email, their phone, or their External Ref where the source records neither.', eg: 'arjun.mehta@example.com' }),
      c('Requirement Code', '_requirement', { req: true, help: 'Must match a row on the Requirements sheet.', eg: 'REQ-2026-001' }),
      c('Stage', 'stage', { req: true, t: 'list', list: 'stage', help: 'Where this candidate currently sits in the pipeline.', eg: 'TL_REVIEW' }),
      c('Source', 'source', { eg: 'Naukri' }),
      c('Match Score', 'matchScore', { t: 'number', help: '0-100. Leave blank to let the system compute it.', eg: '' }),
      c('Interview Date/Time', 'interviewAt', { t: 'date', help: 'If an interview is already scheduled.', eg: '' }),
      c('Interview Round', 'interviewRound', { t: 'number', eg: '1' }),
      c('Interview Mode', 'interviewMode', { t: 'list', list: 'interviewMode' }),
      c('Interviewer', 'interviewer'),
      c('Interview Result', 'interviewResult', { t: 'list', list: 'interviewResult' }),
      c('Interview Feedback', 'interviewFeedback'),
      c('Offer Status', 'offerStatus', { t: 'list', list: 'offerStatus' }),
      c('Offered CTC', 'offeredCtc', { t: 'number', help: 'Annual, in rupees.', eg: '1800000' }),
      c('Offer Date', 'offerDate', { t: 'date' }),
      c('Joining Date', 'joiningDate', { t: 'date' }),
      c('Rejection Reason', 'rejectionReason', { help: 'Required when Stage is REJECTED — this is what the rejected-candidate history keeps.', eg: '' }),
    ],
  },

  // --- 4. Accounts ---------------------------------------------------------
  {
    name: 'Invoices',
    product: 'Accounts',
    model: 'invoice',
    key: ['invoiceNumber'],
    title: 'Invoices (Accounts)',
    note: 'Invoice Number is the key. Client Name must appear on the Clients sheet; Candidate and Requirement are optional but link the invoice to the placement it was raised for. Amount is the fee BEFORE GST and TDS.',
    lookups: { clientId: { sheet: 'Clients', by: 'name', from: 'Client Name' } },
    columns: [
      c('Invoice Number', 'invoiceNumber', { req: true, help: 'Unique.', eg: 'INV-2026-0041' }),
      c('Client Name', '_client', { req: true, eg: 'Orbit Software Solutions' }),
      c('Candidate Email or Phone', '_candidate', { help: 'The placement this invoice is for — email, phone or External Ref.', eg: 'arjun.mehta@example.com' }),
      c('Requirement Code', '_requirement', { eg: 'REQ-2026-001' }),
      c('Invoice Date', 'invoiceDate', { req: true, t: 'date', eg: '2026-09-15' }),
      c('Due Date', 'dueDate', { t: 'date', eg: '2026-09-21' }),
      c('Amount', 'amount', { req: true, t: 'number', help: 'The fee, before GST and TDS.', eg: '150000' }),
      c('GST %', 'gstPercent', { t: 'number', eg: '18' }),
      c('TDS %', 'tdsPercent', { t: 'number', eg: '10' }),
      c('Status', 'status', { t: 'list', list: 'invoiceStatus', eg: 'Pending' }),
      c('Received Amount', 'receivedAmount', { t: 'number', help: 'How much has actually come in.', eg: '0' }),
      c('Paid Date', 'paidDate', { t: 'date' }),
      c('Bank Transaction Ref', 'bankTxnId'),
      c('Fee %', 'feePercent', { t: 'number', help: 'Your fee as a percentage of the candidate CTC.', eg: '8.33' }),
      c('Offered CTC', 'offeredCtc', { t: 'number', eg: '1800000' }),
      c('Joining Date', 'joiningDate', { t: 'date' }),
      c('Payment Terms', 'paymentTerms'),
      c('TDS Certificate Received', 'tdsCertReceived', { t: 'list', list: 'yesNo' }),
      c('TDS Certificate Ref', 'tdsCertRef'),
      c('Notes', 'notes'),
    ],
  },
];

module.exports = { SHEETS, LISTS };

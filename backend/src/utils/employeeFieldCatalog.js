// ---------------------------------------------------------------------------
// THE BUILT-IN EMPLOYEE FIELDS — the old fields the Employee form, the
// profile and the list really carry, described once.
//
// Employee Management -> Manage Fields shows these AND the fields an
// administrator added, in ONE list. A built-in field's DATABASE column and
// type never change here; what HR may change is its label, help text,
// required flag, visibility (Pause / Resume) and order.
//
// Each entry:
//   col      the Employee column (or, for `position` / `roleCode`, the form
//            control that writes the seat / the login role). The stored
//            definition row has key `core.<col>`.
//   label    the default label — exactly the words the form used before.
//   section  where it sits on the form (fixed by the form's layout).
//   type     TEXT | DATE | DROPDOWN  (display only).
//   choices  the master list a dropdown reads (edited in Company Setup ->
//            Master lists, not here — one source of truth).
//   where    which screens draw it: form / profile / list.
//   needed   the system cannot work without it: no Pause button, label-only
//            edits. `neededWhy` says so in plain words.
//   reqLocked  always required (cannot be made optional).
//
// "Needed by the system" was decided from the code:
//   * employeeCode, name, email, department, designation — the person and
//     their login (role, product access and data scope are derived from
//     department + designation).
//   * team, tl, stl, reportingManagerId — scope of a team lead and the
//     leave / resignation approval chain read them.
//   * employmentStatus, dateOfJoining, shift — attendance, leave and
//     payroll are worked out from them.
//   * position, roleCode — the seat and the login role.
//   * bank name / account / IFSC, PAN, UAN, PF, ESI — payroll, payslips and
//     the statutory reports read them.
// Everything else (blood group, gender, date of birth, address, emergency
// contact, phone, location, branch, employee type, experience, education,
// skills, Aadhaar) is display / HR information and can be paused.
// ---------------------------------------------------------------------------

const S = {
  personal: 'Personal Information',
  contact: 'Contact Information',
  address: 'Address',
  emergency: 'Emergency Contact',
  employment: 'Employment Details',
  education: 'Education & Work Experience',
  bank: 'Bank & Statutory Details',
};
const CUSTOM_SECTION = 'Extra details';
const SECTION_ORDER = [S.personal, S.contact, S.address, S.emergency, S.employment, S.education, S.bank, CUSTOM_SECTION];

const WHY = {
  login: 'It is the person and their login.',
  scope: 'The login role and what this person can see come from it.',
  team: 'A team lead is limited to their own team.',
  chain: 'Leave and resignation approvals follow it.',
  hr: 'Attendance, leave and payroll are worked out from it.',
  seat: 'Positions (seats) are recorded through it.',
  role: 'It sets the login role.',
  pay: 'Payroll and payslips use it.',
};

// [col, label, section, type, extra]
const row = (col, label, section, type, extra = {}) => ({
  col, key: `core.${col}`, label, section, type, where: { form: true, profile: true, list: false }, ...extra,
});
const need = (why, extra = {}) => ({ needed: true, neededWhy: why, ...extra });

const CATALOG = [
  row('name', 'Full name', S.personal, 'TEXT', { ...need(WHY.login), reqLocked: true, where: { form: true, profile: true, list: true } }),
  row('dateOfBirth', 'Date of Birth', S.personal, 'DATE'),
  row('gender', 'Gender', S.personal, 'DROPDOWN', { choices: 'Genders' }),
  row('bloodGroup', 'Blood Group', S.personal, 'DROPDOWN', { choices: 'Blood Groups' }),

  row('phone', 'Phone', S.contact, 'TEXT'),
  row('email', 'Email', S.contact, 'TEXT', { ...need('It is the sign-in address.'), reqLocked: true }),

  row('addressType', 'Address Type', S.address, 'DROPDOWN', { choices: 'Address Types' }),
  row('addressLine1', 'Address Line 1', S.address, 'TEXT'),
  row('addressLine2', 'Address Line 2', S.address, 'TEXT'),
  row('city', 'City / Town', S.address, 'TEXT'),
  row('district', 'District', S.address, 'TEXT'),
  row('state', 'State / Province', S.address, 'TEXT'),
  row('country', 'Country', S.address, 'TEXT'),
  row('postalCode', 'Postal Code', S.address, 'TEXT'),

  row('emergencyContactName', 'Emergency contact name', S.emergency, 'TEXT'),
  row('emergencyContactRelation', 'Emergency contact relation', S.emergency, 'TEXT'),
  row('emergencyContactPhone', 'Emergency contact number', S.emergency, 'TEXT'),

  row('employeeCode', 'Employee ID', S.employment, 'TEXT', { ...need(WHY.login), reqLocked: true, where: { form: true, profile: true, list: true } }),
  row('department', 'Department', S.employment, 'DROPDOWN', { ...need(WHY.scope), reqLocked: true, choices: 'Departments' }),
  row('position', 'Position', S.employment, 'DROPDOWN', need(WHY.seat, { where: { form: true, profile: true, list: true } })),
  row('team', 'Team', S.employment, 'DROPDOWN', need(WHY.team, { choices: 'Teams', where: { form: true, profile: true, list: true } })),
  row('designation', 'Designation', S.employment, 'DROPDOWN', { ...need(WHY.scope), reqLocked: true, choices: 'Designations', where: { form: true, profile: true, list: true } }),
  row('location', 'Location', S.employment, 'TEXT'),
  row('branch', 'Branch', S.employment, 'DROPDOWN', { choices: 'Branches' }),
  row('shift', 'Shift', S.employment, 'DROPDOWN', need(WHY.hr, { choices: 'Shifts' })),
  row('employmentStatus', 'Status', S.employment, 'DROPDOWN', need(WHY.hr, { choices: 'Employment Statuses', where: { form: true, profile: true, list: true } })),
  row('employeeType', 'Employee Type', S.employment, 'DROPDOWN', { choices: 'Employment Types' }),
  row('dateOfJoining', 'Date of Joining', S.employment, 'DATE', need(WHY.hr)),
  row('reportingManagerId', 'Reporting Manager', S.employment, 'DROPDOWN', need(WHY.chain)),
  row('tl', 'TL', S.employment, 'TEXT', need(WHY.chain)),
  row('stl', 'STL', S.employment, 'TEXT', need(WHY.chain)),
  row('roleCode', 'Role (login)', S.employment, 'DROPDOWN', need(WHY.role, { where: { form: true, profile: false, list: false } })),

  row('employmentExperience', 'Employment Type', S.education, 'DROPDOWN', { choices: 'Experience', hint: 'Fresher or Experienced' }),
  row('educationDetails', 'Education details', S.education, 'TEXT'),
  row('skills', 'Skills & certifications', S.education, 'TEXT'),

  row('bankName', 'Bank name', S.bank, 'TEXT', need(WHY.pay)),
  row('bankAccountNumber', 'Account number', S.bank, 'TEXT', need(WHY.pay)),
  row('ifscCode', 'IFSC code', S.bank, 'TEXT', need(WHY.pay)),
  row('panNumber', 'PAN number', S.bank, 'TEXT', need(WHY.pay)),
  row('aadhaarNumber', 'Aadhaar', S.bank, 'TEXT', { hint: 'Only the last 4 digits are kept' }),
  row('uanNumber', 'UAN number', S.bank, 'TEXT', need(WHY.pay)),
  row('pfNumber', 'PF number', S.bank, 'TEXT', need(WHY.pay)),
  row('esiNumber', 'ESI number', S.bank, 'TEXT', need(WHY.pay)),
];

const BY_COL = new Map(CATALOG.map((c) => [c.col, c]));
const BY_KEY = new Map(CATALOG.map((c) => [c.key, c]));
const isBuiltInKey = (key) => typeof key === 'string' && key.startsWith('core.');
const sectionIndex = (name) => {
  const i = SECTION_ORDER.indexOf(name);
  return i < 0 ? SECTION_ORDER.length - 1 : i;
};

module.exports = {
  CATALOG, BY_COL, BY_KEY, SECTIONS: S, SECTION_ORDER, CUSTOM_SECTION, isBuiltInKey, sectionIndex,
};

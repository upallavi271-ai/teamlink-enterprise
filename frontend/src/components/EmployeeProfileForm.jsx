import { useEffect, useState } from 'react';
import Combo from './Combo.jsx';
import api from '../api';
// LIVE MASTERS (2026-09-29): branches, statuses, genders … come from
// GET /api/masters; the constants below are only the first-paint fallback.
import { useMasters, withCurrent } from '../utils/masters';

// ---------------------------------------------------------------------------
// THE EMPLOYEE FORM — one set of sections and fields for both doors.
//
// HR edits it on the employee record (pages/EmployeeDetail.jsx) and the
// employee fills in their own on My Employee Profile (pages/hrms/MyProfile.jsx).
// It used to be two hand-written forms that had drifted apart — the
// employee's had date of birth and gender, HR's had name and Aadhaar — so the
// employee could not see the record HR sees. Now both render this.
//
// Each field says WHO may write it:
//   'both' — HR, and the employee on their own profile. These are exactly
//            SELF_SERVICE_FIELDS in routes/employees.js.
//   'hr'   — HR only. Shown to the employee, never editable by them; PUT /me
//            ignores these however they are sent.
//   'ro'   — nobody here (set elsewhere: joining, the seat, the manager).
// A disabled input is presentation. The server is what refuses.
// ---------------------------------------------------------------------------

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const BRANCHES = ['Bengaluru', 'Chennai', 'Hyderabad'];
const EMP_STATUSES = ['Active', 'On Probation', 'Notice Period', 'Exit Process', 'Relieved', 'Exited'];

// The fields the employee may submit for review — mirrors SELF_SERVICE_FIELDS,
// minus aadhaarNumber: the full number is never typed into a saved field on
// the employee's side (Section 29 of the Aadhaar Act). It goes through the
// identity-verification panel instead, and only the last four digits are kept.
export const SELF_FIELDS = [
  'phone', 'email', 'dateOfBirth', 'gender', 'bloodGroup',
  'addressType', 'addressLine1', 'addressLine2', 'city', 'district', 'state', 'country', 'postalCode',
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'branch', 'shift', 'employmentExperience', 'educationDetails', 'skills',
  'bankName', 'bankAccountNumber', 'ifscCode', 'panNumber', 'uanNumber', 'pfNumber', 'esiNumber',
];

// A form-state object for `keys`, read off an employee record. Dates become
// "YYYY-MM-DD" for <input type="date">; everything absent becomes ''.
export function formFromEmployee(employee, keys) {
  const f = {};
  keys.forEach((k) => {
    const v = employee ? employee[k] : '';
    if (v === null || v === undefined || v === '') {
      f[k] = k === 'employmentExperience' ? 'Fresher' : '';
      return;
    }
    f[k] = k === 'dateOfBirth' ? String(v).slice(0, 10) : v;
  });
  return f;
}

function display(employee, key) {
  if (!employee) return '';
  if (key === 'reportingManager') return employee.reportingManager?.name || '';
  if (key === 'dateOfJoining' || key === 'dateOfBirth') {
    return employee[key] ? new Date(employee[key]).toLocaleDateString('en-GB') : '';
  }
  const v = employee[key];
  return v === null || v === undefined ? '' : String(v);
}

// `mode`       'hr' | 'self'
// `readOnly`   true renders every field disabled (a submitted / locked form)
// `isAdmin`    HR mode only: may change Employment Status
// `hrEmployment` HR mode only: the department / seat / team controls, which
//              carry their own rules (the login follows a department change,
//              the seat list belongs to the saved department) and stay with
//              the page that owns them.
// `hrOptions`  HR mode only — THE FULL EDIT FORM (2026-09-29). When given, the
//              fields the Add form and the record carry but the profile used to
//              show read-only become editable: Employment Type, Date of
//              Joining, Reporting Manager, TL, STL and the login Role. Shape:
//              { reportingManagers:[{id,name}], empTypes:[], statuses:[],
//                branches:[], roles:[{code,name,isSystem}], hasLogin }
//              (live lists — nothing below is the source of truth when given).
// `documents`  DOCUMENTS ARE PART OF THE FORM (user, 2026-09-29): the page
//              passes <EmployeeDocuments embedded … /> and it is drawn as the
//              form's last section, in both modes. It carries its own per-role
//              actions (the server decides upload / view / delete).
export default function EmployeeProfileForm({
  form, setForm, employee, mode = 'self', readOnly = false, isAdmin = false, hrEmployment = null, hrOptions = null,
  canEditCode = false, documents = null,
}) {
  const full = mode === 'hr' && !readOnly && !!hrOptions;
  const masters = useMasters();
  const writable = (who) => !readOnly && (who === 'both' || (who === 'hr' && mode === 'hr'));
  const inForm = (k) => Object.prototype.hasOwnProperty.call(form, k);
  const value = (k) => (inForm(k) ? (form[k] ?? '') : display(employee, k));
  // The form holds "YYYY-MM-DD"; read as a LOCAL date so it never shows the
  // day before west of UTC.
  const dobShown = inForm('dateOfBirth')
    ? (form.dateOfBirth ? new Date(`${String(form.dateOfBirth).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB') : '')
    : display(employee, 'dateOfBirth');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  // A master list (live), plus the value already on the record so opening the
  // form never changes a legacy value.
  const live = (key, fallback, field) => withCurrent((masters && masters[key] && masters[key].length) ? masters[key] : fallback, field ? value(field) : []);
  const branchList = live('branches', (hrOptions && hrOptions.branches && hrOptions.branches.length) ? hrOptions.branches : BRANCHES, 'branch');
  const statusList = live('employmentStatuses', (hrOptions && hrOptions.statuses && hrOptions.statuses.length) ? hrOptions.statuses : EMP_STATUSES, 'employmentStatus');

  // DESIGNATION IS A DROPDOWN off the designation master (DesignationRole —
  // the list Add Employee picks from). Loaded only when HR can write it. The
  // value already on the record is always offered, even a legacy one that is
  // not in the master, so opening the form never changes it; the server
  // refuses a CHANGE to a value outside the master.
  const designationWritable = writable('hr');
  const [designations, setDesignations] = useState(null);
  useEffect(() => {
    if (!designationWritable) return undefined;
    let alive = true;
    api.get('/employees/management/designations')
      .then((r) => { if (alive) setDesignations(r.data.designations || []); })
      .catch(() => { if (alive) setDesignations([]); });
    return () => { alive = false; };
  }, [designationWritable]);
  const designationField = () => {
    if (!designationWritable || !designations || !designations.length) return text('designation', 'Designation', 'hr');
    const current = value('designation');
    const inMaster = designations.some((d) => d.designation.toLowerCase() === String(current).toLowerCase());
    return (
      <label className="field" key="designation">
        <span>Designation</span>
        <Combo value={current} onChange={set('designation')}>
          <option value="">Select designation</option>
          {current && !inMaster && <option value={current}>{`${current} (current — not in the master)`}</option>}
          {designations.map((d) => (
            <option key={d.designation} value={d.designation}>{d.label || d.designation}</option>
          ))}
        </Combo>
      </label>
    );
  };

  // A plain text field. Anything this caller cannot write is shown, disabled,
  // with the value on record — the whole form, every section, is always visible.
  const text = (k, label, who = 'both', props = {}) => (
    <label className="field" key={k}>
      <span>{label}</span>
      <input value={value(k)} disabled={!writable(who)} onChange={set(k)} {...props} />
    </label>
  );
  const pick = (k, label, choices, who = 'both', { creatable = false, blank = 'Select' } = {}) => (
    <label className="field" key={k}>
      <span>{label}</span>
      {writable(who) ? (
        <Combo creatable={creatable} value={value(k)} onChange={set(k)}>
          {blank !== null && <option value="">{blank}</option>}
          {choices.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      ) : <input value={value(k)} disabled />}
    </label>
  );
  const shown = (k, label) => (
    <label className="field" key={k}>
      <span>{label}</span>
      <input value={display(employee, k)} disabled />
    </label>
  );

  // Aadhaar: HR keeps the field it always had; the employee sees only what
  // verification kept — never the full number, and never an input for it.
  const aadhaar = mode === 'hr'
    ? text('aadhaarNumber', 'Aadhaar (only the last 4 digits are kept)', 'hr', {
      placeholder: employee?.aadhaarLast4 ? `On file: XXXX XXXX ${employee.aadhaarLast4}` : '12 digits',
      inputMode: 'numeric',
    })
    : (
      <label className="field" key="aadhaar">
        <span>Aadhaar</span>
        <input
          disabled
          value={employee?.verification?.aadhaar?.last4
            ? `••••${employee.verification.aadhaar.last4}${employee.verification.aadhaar.verified ? ' (verified)' : ' (checked only)'}`
            : 'Not verified — use Identity verification below'}
        />
      </label>
    );

  return (
    <>
      <h3>Personal Information</h3>
      <div className="grid-2">
        {text('name', 'Full name', 'hr')}
        <label className="field">
          <span>Date of Birth</span>
          {writable('both')
            ? <input type="date" value={value('dateOfBirth')} onChange={set('dateOfBirth')} />
            : <input value={dobShown} disabled />}
        </label>
        {pick('gender', 'Gender', live('genders', ['Male', 'Female', 'Other'], 'gender'))}
        {pick('bloodGroup', 'Blood Group', live('bloodGroups', BLOOD_GROUPS, 'bloodGroup'))}
      </div>

      <h3 style={{ marginTop: 14 }}>Contact Information</h3>
      <div className="grid-2">
        {text('phone', 'Phone')}
        {text('email', 'Email')}
      </div>

      <h3 style={{ marginTop: 14 }}>Address</h3>
      <div className="grid-2">
        {pick('addressType', 'Address Type', live('addressTypes', ['Current', 'Permanent'], 'addressType'), 'both', { blank: 'Select type' })}
        {text('addressLine1', 'Address Line 1')}
        {text('addressLine2', 'Address Line 2')}
        {text('city', 'City / Town')}
        {text('district', 'District')}
        {text('state', 'State / Province')}
        {text('country', 'Country')}
        {text('postalCode', 'Postal Code')}
      </div>

      <h3 style={{ marginTop: 14 }}>Emergency Contact</h3>
      <div className="grid-2">
        {text('emergencyContactName', 'Name')}
        {text('emergencyContactRelation', 'Relation')}
        {text('emergencyContactPhone', 'Number')}
      </div>

      <h3 style={{ marginTop: 14 }}>Employment Details</h3>
      {mode === 'self' && (
        <div className="small-muted" style={{ marginBottom: 8 }}>
          Department, designation, position, team and joining details are set by HR.
        </div>
      )}
      <div className="grid-2">
        {/* Super Admin can change the Employee ID right here (user, 2026-09-29).
            Saving sends it through the same checked endpoint as "Change ID"
            (unique, audited old → new); everyone else sees it read-only. */}
        {canEditCode && mode === 'hr' && !readOnly
          ? text('employeeCode', 'Employee ID (Super Admin can change)', 'hr', { maxLength: 20, spellCheck: false })
          : shown('employeeCode', 'Employee ID')}
        {mode === 'hr' && !readOnly && hrEmployment ? hrEmployment : (
          <>
            {shown('department', 'Department')}
            {shown('position', 'Position')}
            {shown('team', 'Team')}
          </>
        )}
        {designationField()}
        {text('location', 'Location', 'hr')}
        {pick('branch', 'Branch', branchList, 'both', { creatable: true, blank: 'Select branch' })}
        {pick('shift', 'Shift', live('shifts', [], 'shift'), 'both', { creatable: true, blank: 'Select shift' })}
        {mode === 'hr' && (isAdmin || full)
          ? pick('employmentStatus', 'Status', statusList, 'hr', { blank: null })
          : shown('employmentStatus', 'Status')}
        {full ? pick('employeeType', 'Employee Type', live('employmentTypes', hrOptions.empTypes || [], 'employeeType'), 'hr', { creatable: true, blank: 'Select type' }) : shown('employeeType', 'Employee Type')}
        {full ? (
          <label className="field" key="dateOfJoining">
            <span>Date of Joining</span>
            <input type="date" value={form.dateOfJoining || ''} onChange={set('dateOfJoining')} />
          </label>
        ) : shown('dateOfJoining', 'Date of Joining')}
        {full ? (
          <label className="field" key="reportingManagerId">
            <span>Reporting Manager</span>
            <Combo value={form.reportingManagerId || ''} onChange={set('reportingManagerId')}>
              <option value="">No reporting manager</option>
              {(hrOptions.reportingManagers || []).filter((m) => m.id !== employee?.id).map((m) => <option key={m.id} value={m.id}>{m.label || m.name}</option>)}
              {/* The manager on file stays pickable even if they have since left. */}
              {form.reportingManagerId && employee?.reportingManager && form.reportingManagerId === employee.reportingManagerId && !(hrOptions.reportingManagers || []).some((m) => m.id === form.reportingManagerId)
                && <option value={form.reportingManagerId}>{employee.reportingManager.name} (no longer active)</option>}
            </Combo>
          </label>
        ) : shown('reportingManager', 'Reporting Manager')}
        {full && text('tl', 'TL', 'hr')}
        {full && text('stl', 'STL', 'hr')}
        {full && hrOptions.hasLogin && (
          <label className="field" key="roleCode">
            <span>Role (login)</span>
            <Combo value={form.roleCode || ''} onChange={set('roleCode')}>
              <option value="">Keep the current role</option>
              {(hrOptions.roles || []).map((r) => <option key={r.code} value={r.code}>{r.name}{r.isSystem ? '' : ' (custom)'}</option>)}
            </Combo>
          </label>
        )}
      </div>

      <h3 style={{ marginTop: 14 }}>Education & Work Experience</h3>
      <div className="grid-2">
        {pick('employmentExperience', 'Employment Type', live('experience', ['Fresher', 'Experienced'], 'employmentExperience'), 'both', { blank: null })}
        {text('educationDetails', 'Education details')}
        {text('skills', 'Skills & certifications')}
      </div>

      <h3 style={{ marginTop: 14 }}>Bank & Statutory Details</h3>
      <div className="small-muted" style={{ marginBottom: 8 }}>Restricted — shown on payslips.</div>
      <div className="grid-2">
        {text('bankName', 'Bank name')}
        {text('bankAccountNumber', 'Account number')}
        {text('ifscCode', 'IFSC code')}
        {text('panNumber', 'PAN number')}
        {aadhaar}
        {text('uanNumber', 'UAN number')}
        {text('pfNumber', 'PF number')}
        {text('esiNumber', 'ESI number')}
      </div>

      {documents}
    </>
  );
}

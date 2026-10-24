import { Fragment, useEffect, useState } from 'react';
import Combo from './Combo.jsx';
import api from '../api';
// LIVE MASTERS (2026-09-29): branches, statuses, genders … come from
// GET /api/masters; the constants below are only the first-paint fallback.
import { useMasters, withCurrent } from '../utils/masters';
// MANAGE FIELDS: labels, help text, required star, order and Pause of the
// built-in fields — set in Employee Management -> Manage Fields.
import { useFieldLayout } from '../utils/employeeFieldLayout';

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
  const FL = useFieldLayout();
  // The label HR gave the field, its ✱ when required, and its help text.
  const labelOf = (k, fallback) => FL.label(k, fallback);
  const star = (k) => null;
  const help = (k) => (FL.help(k) ? <small className="cell-muted">{FL.help(k)}</small> : null);
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
  // REPORTING MANAGER FOLLOWS THE DEPARTMENT (user, 2026-10-10). The pickers below are fed by the
  // server for the Department (and role) chosen IN THIS FORM: a recruiter sees the team leads of
  // their own department, with a count. Changing the department re-filters and clears a manager that
  // no longer fits. "Other departments" is off unless HR switches it on.
  const [cross, setCross] = useState(false);
  const [mgr, setMgr] = useState(null);
  const formDept = inForm('department') ? form.department : employee?.department;
  const formDesig = inForm('designation') ? form.designation : employee?.designation;
  useEffect(() => {
    if (!full || !employee) return undefined;
    let alive = true;
    api.get('/employees/management/manager-options', {
      params: { department: formDept || '', designation: formDesig || '', employeeId: employee.id, roleCode: form.roleCode || '', cross: cross ? 1 : 0 },
    }).then((r) => { if (alive) setMgr(r.data); }).catch(() => { if (alive) setMgr(null); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, employee?.id, formDept, formDesig, form.roleCode, cross]);
  const mgrIds = new Set(((mgr && mgr.options) || []).map((o) => o.id));
  const mgrNames = new Set(((mgr && mgr.options) || []).map((o) => o.name));
  useEffect(() => {
    if (!full || !mgr || !employee) return;
    const deptMoved = formDept !== employee.department;
    const patch = {};
    const cur = form.reportingManagerId || '';
    // Exactly one fits and nothing is chosen yet -> choose it. A manager that no longer fits -> clear it.
    if (!cur && mgr.single) patch.reportingManagerId = mgr.single;
    else if (cur && !mgrIds.has(cur) && (deptMoved || cur !== (employee.reportingManagerId || ''))) patch.reportingManagerId = '';
    ['tl', 'stl'].forEach((k) => {
      const v = form[k] || '';
      if (v && !mgrNames.has(v) && (deptMoved || v !== (employee[k] || ''))) patch[k] = '';
    });
    if (cross !== !!form.crossDepartment) patch.crossDepartment = cross;
    if (Object.keys(patch).length) setForm({ ...form, ...patch });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mgr, cross]);
  const mgrBlock = () => {
    const opts = (mgr && mgr.options) || [];
    const kindOpts = (kinds) => opts.filter((o) => kinds.includes(o.role));
    return {
      note: mgr && (
        <span className="small-muted" data-testid="manager-count">
          {opts.length ? mgr.title : (mgr.empty || '')}
        </span>
      ),
      options: opts,
      tl: kindOpts(['TL', 'MANAGER', 'ASSISTANT_MANAGER', 'ADMIN', 'SUPER_ADMIN']),
      stl: kindOpts(['STL']),
    };
  };
  const designationField = () => {
    if (!designationWritable || !designations || !designations.length) return text('designation', 'Designation', 'hr');
    const current = value('designation');
    const inMaster = designations.some((d) => d.designation.toLowerCase() === String(current).toLowerCase());
    return (
      <label className="field" key="designation">
        <span>{labelOf('designation', 'Designation')}{star('designation')}</span>
        <Combo value={current} onChange={set('designation')}>
          <option value="">Select designation</option>
          {current && !inMaster && <option value={current}>{`${current} (current — not in the master)`}</option>}
          {designations.map((d) => (
            <option key={d.designation} value={d.designation}>{d.label || d.designation}</option>
          ))}
        </Combo>
        {help('designation')}
      </label>
    );
  };

  // A plain text field. Anything this caller cannot write is shown, disabled,
  // with the value on record — the whole form, every section, is always visible.
  const text = (k, label, who = 'both', props = {}) => (
    <label className="field" key={k}>
      <span>{labelOf(k, label)}{star(k)}</span>
      <input value={value(k)} disabled={!writable(who)} onChange={set(k)} {...props} />
      {help(k)}
    </label>
  );
  const pick = (k, label, choices, who = 'both', { creatable = false, blank = 'Select' } = {}) => (
    <label className="field" key={k}>
      <span>{labelOf(k, label)}{star(k)}</span>
      {writable(who) ? (
        <Combo creatable={creatable} value={value(k)} onChange={set(k)}>
          {blank !== null && <option value="">{blank}</option>}
          {choices.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      ) : <input value={value(k)} disabled />}
      {help(k)}
    </label>
  );
  const shown = (k, label) => (
    <label className="field" key={k}>
      <span>{labelOf(k === 'reportingManager' ? 'reportingManagerId' : k, label)}</span>
      <input value={display(employee, k)} disabled />
      {help(k === 'reportingManager' ? 'reportingManagerId' : k)}
    </label>
  );
  // A section: its fields in the order HR set, the paused ones left out; a
  // section with nothing left shows no heading at all.
  const section = (title, items, { first = false, note = null } = {}) => {
    const list = FL.sort(items.filter(([, node]) => node), (it) => it[0]);
    if (!list.length) return null;
    return (
      <>
        <h3 style={first ? undefined : { marginTop: 14 }}>{title}</h3>
        {note}
        <div className="grid-2">{list.map(([k, node]) => (node && node.key ? node : <Fragment key={k}>{node}</Fragment>))}</div>
      </>
    );
  };

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
      {section('Personal Information', [
        ['name', text('name', 'Full name', 'hr')],
        ['dateOfBirth', (
          <label className="field" key="dateOfBirth">
            <span>{labelOf('dateOfBirth', 'Date of Birth')}{star('dateOfBirth')}</span>
            {writable('both')
              ? <input type="date" value={value('dateOfBirth')} onChange={set('dateOfBirth')} />
              : <input value={dobShown} disabled />}
            {help('dateOfBirth')}
          </label>
        )],
        ['gender', pick('gender', 'Gender', live('genders', ['Male', 'Female', 'Other'], 'gender'))],
        ['bloodGroup', pick('bloodGroup', 'Blood Group', live('bloodGroups', BLOOD_GROUPS, 'bloodGroup'))],
      ], { first: true })}

      {section('Contact Information', [
        ['phone', text('phone', 'Phone')],
        ['email', text('email', 'Email')],
      ])}

      {section('Address', [
        ['addressType', pick('addressType', 'Address Type', live('addressTypes', ['Current', 'Permanent'], 'addressType'), 'both', { blank: 'Select type' })],
        ['addressLine1', text('addressLine1', 'Address Line 1')],
        ['addressLine2', text('addressLine2', 'Address Line 2')],
        ['city', text('city', 'City / Town')],
        ['district', text('district', 'District')],
        ['state', text('state', 'State / Province')],
        ['country', text('country', 'Country')],
        ['postalCode', text('postalCode', 'Postal Code')],
      ])}

      {section('Emergency Contact', [
        ['emergencyContactName', text('emergencyContactName', 'Name')],
        ['emergencyContactRelation', text('emergencyContactRelation', 'Relation')],
        ['emergencyContactPhone', text('emergencyContactPhone', 'Number')],
      ])}

      {section('Employment Details', [
        // Super Admin can change the Employee ID right here (user, 2026-09-29).
        // Saving sends it through the same checked endpoint as "Change ID"
        // (unique, audited old -> new); everyone else sees it read-only.
        ['employeeCode', canEditCode && mode === 'hr' && !readOnly
          ? text('employeeCode', 'Employee ID (Super Admin can change)', 'hr', { maxLength: 20, spellCheck: false })
          : shown('employeeCode', 'Employee ID')],
        ['department', mode === 'hr' && !readOnly && hrEmployment ? hrEmployment : (
          <>
            {shown('department', 'Department')}
            {shown('position', 'Position')}
            {shown('team', 'Team')}
          </>
        )],
        ['designation', designationField()],
        ['location', text('location', 'Location', 'hr')],
        ['branch', pick('branch', 'Branch', branchList, 'both', { creatable: true, blank: 'Select branch' })],
        ['shift', pick('shift', 'Shift', live('shifts', [], 'shift'), 'both', { creatable: true, blank: 'Select shift' })],
        ['employmentStatus', mode === 'hr' && (isAdmin || full)
          ? pick('employmentStatus', 'Status', statusList, 'hr', { blank: null })
          : shown('employmentStatus', 'Status')],
        ['employeeType', full ? pick('employeeType', 'Employee Type', live('employmentTypes', hrOptions.empTypes || [], 'employeeType'), 'hr', { creatable: true, blank: 'Select type' }) : shown('employeeType', 'Employee Type')],
        ['dateOfJoining', full ? (
          <label className="field" key="dateOfJoining">
            <span>{labelOf('dateOfJoining', 'Date of Joining')}{star('dateOfJoining')}</span>
            <input type="date" value={form.dateOfJoining || ''} onChange={set('dateOfJoining')} />
            {help('dateOfJoining')}
          </label>
        ) : shown('dateOfJoining', 'Date of Joining')],
        ['reportingManagerId', full ? (() => {
          const b = mgrBlock();
          return (
            <label className="field" key="reportingManagerId">
              <span>{labelOf('reportingManagerId', 'Reporting Manager')}{star('reportingManagerId')}</span>
              <Combo value={form.reportingManagerId || ''} onChange={set('reportingManagerId')}>
                <option value="">{b.options.length ? 'No reporting manager' : (mgr && mgr.empty) || 'No reporting manager'}</option>
                {b.options.map((m) => <option key={m.id} value={m.id}>{m.label}{m.otherDept ? ' (other department)' : ''}</option>)}
                {/* The manager on file stays shown (labelled) when they no longer fit or have left - never dropped silently. */}
                {form.reportingManagerId && !b.options.some((m) => m.id === form.reportingManagerId)
                  && <option value={form.reportingManagerId}>{(employee?.reportingManager?.name) || 'Current manager'} (not in this department)</option>}
              </Combo>
              {b.note}
              <span className="small-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, cursor: 'pointer' }} onClick={() => setCross(!cross)}>
                <input type="checkbox" checked={cross} onClick={(e) => e.stopPropagation()} onChange={(e) => setCross(e.target.checked)} />
                Also show team leads of other departments
              </span>
              {help('reportingManagerId')}
            </label>
          );
        })() : shown('reportingManager', 'Reporting Manager')],
        ['tl', full && (() => {
          const b = mgrBlock();
          const names = [...new Set(b.tl.map((o) => o.name))];
          return (
            <label className="field" key="tl">
              <span>{labelOf('tl', 'TL')}{star('tl')}</span>
              <Combo value={form.tl || ''} onChange={set('tl')}>
                <option value="">No TL</option>
                {names.map((n) => <option key={n}>{n}</option>)}
                {form.tl && !names.includes(form.tl) && <option value={form.tl}>{form.tl} (not in this department)</option>}
              </Combo>
              {help('tl')}
            </label>
          );
        })()],
        ['stl', full && (() => {
          const b = mgrBlock();
          const names = [...new Set(b.stl.map((o) => o.name))];
          return (
            <label className="field" key="stl">
              <span>{labelOf('stl', 'STL')}{star('stl')}</span>
              <Combo value={form.stl || ''} onChange={set('stl')}>
                <option value="">No STL</option>
                {names.map((n) => <option key={n}>{n}</option>)}
                {form.stl && !names.includes(form.stl) && <option value={form.stl}>{form.stl} (not in this department)</option>}
              </Combo>
              {help('stl')}
            </label>
          );
        })()],
        ['roleCode', full && hrOptions.hasLogin && (
          <label className="field" key="roleCode">
            <span>{labelOf('roleCode', 'Role (login)')}</span>
            <Combo value={form.roleCode || ''} onChange={set('roleCode')}>
              <option value="">Keep the current role</option>
              {(hrOptions.roles || []).map((r) => <option key={r.code} value={r.code}>{r.name}{r.isSystem ? '' : ' (custom)'}</option>)}
            </Combo>
          </label>
        )],
      ], {
        note: mode === 'self' ? (
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Department, designation, position, team and joining details are set by HR.
          </div>
        ) : null,
      })}

      {section('Education & Work Experience', [
        ['employmentExperience', pick('employmentExperience', 'Employment Type', live('experience', ['Fresher', 'Experienced'], 'employmentExperience'), 'both', { blank: null })],
        ['educationDetails', text('educationDetails', 'Education details')],
        ['skills', text('skills', 'Skills & certifications')],
      ])}

      {section('Bank & Statutory Details', [
        ['bankName', text('bankName', 'Bank name')],
        ['bankAccountNumber', text('bankAccountNumber', 'Account number')],
        ['ifscCode', text('ifscCode', 'IFSC code')],
        ['panNumber', text('panNumber', 'PAN number')],
        ['aadhaarNumber', aadhaar],
        ['uanNumber', text('uanNumber', 'UAN number')],
        ['pfNumber', text('pfNumber', 'PF number')],
        ['esiNumber', text('esiNumber', 'ESI number')],
      ], { note: <div className="small-muted" style={{ marginBottom: 8 }}>Restricted — shown on payslips.</div> })}

      {documents}
    </>
  );
}

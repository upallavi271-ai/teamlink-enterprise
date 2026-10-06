import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { isAdmin as hasAdminAccess, isHR as hasHrmsAdmin, canEditEmployees } from '../permissions';
import { STATUS_BADGE, statusLabel } from '../components/ProfileStatusBanner.jsx';
import Combo from '../components/Combo.jsx';
import EmployeeProfileForm from '../components/EmployeeProfileForm.jsx';
import EmployeeDocuments from '../components/EmployeeDocuments.jsx';
import ExtraFields from '../components/employees/ExtraFields.jsx';
import ExportMenu from '../components/ExportMenu.jsx';


const EDIT_FIELDS = [
  // `position` is a seat CODE, not a column on Employee — the server turns it
  // into a PositionAssignment. It is here because the admin edits it on this
  // form; it is NOT on the employee's own SELF_SERVICE_FIELDS, so PUT /me
  // ignores it however it is sent.
  'position',
  'name', 'email', 'phone', 'department', 'team', 'designation', 'location', 'employmentStatus', 'employeeType',
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'addressType',
  'addressLine1', 'addressLine2', 'city', 'district', 'state', 'country', 'postalCode', 'bloodGroup',
  'branch', 'shift', 'employmentExperience', 'educationDetails', 'skills',
  'bankName', 'bankAccountNumber', 'ifscCode', 'panNumber', 'aadhaarNumber', 'uanNumber', 'pfNumber', 'esiNumber',
  // On the employee's own form, so on HR's too — it is ONE form now
  // (components/EmployeeProfileForm.jsx).
  'dateOfBirth', 'gender',
  // THE FULL EDIT FORM (2026-09-29): the Add form / record fields the profile
  // used to show read-only.
  'dateOfJoining', 'tl', 'stl', 'reportingManagerId',
];

export default function EmployeeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  // isHR draws WRITE controls here — granting edit access, ticking an
  // onboarding task, starting offboarding — so it asks Employee Management
  // EDIT and not only VIEW. A Manager and an Assistant Manager are view-only
  // (§3, §4) and hold the view; they must not be handed the buttons.
  const isHR = hasHrmsAdmin(user) && canEditEmployees(user);
  const isAdmin = hasAdminAccess(user);
  const canEditCode = user?.role === 'SUPER_ADMIN';
  // Edit is Employee Management EDIT (HR / Admin / Super Admin, a scoped STL);
  // Manager and Assistant Manager are view-only and never see it. The server
  // re-checks the permission and the scope on save.
  const canEdit = canEditEmployees(user);
  const [searchParams, setSearchParams] = useSearchParams();
  const [hrOptions, setHrOptions] = useState(null);
  const [saving, setSaving] = useState(false);
  const [employee, setEmployee] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [depts, setDepts] = useState([]);
  // Review surface: a decision always carries a reason back to the employee.
  const [reviewNote, setReviewNote] = useState('');
  const [unlockNote, setUnlockNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [credentials, setCredentials] = useState(null);
  // GRANT EDIT ACCESS — temporarily reopening THIS employee's own profile.
  // Nothing to do with Edit Scope (Administration -> Users), which changes
  // which records a login may reach. See the note in routes/employees.js.
  const [grant, setGrant] = useState({ open: false, hours: 48, section: 'All fields', reason: '' });
  const [config, setConfig] = useState(null);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  // The Documents section inside the Edit form; Save changes uploads its files.
  const docsRef = useRef(null);
  const extraRef = useRef(null); // HRMS item 15 — the fields added in Manage Fields
  const [pendingDocs, setPendingDocs] = useState(0);

  function load() {
    api.get(`/employees/${id}`).then((res) => setEmployee(res.data));
    api.get('/admin/departments').then((res) => setDepts(res.data)).catch(() => setDepts([]));
    api.get('/employees/me/config').then((res) => setConfig(res.data)).catch(() => setConfig(null));
    api.get(`/employees/${id}/audit`).then((res) => setHistory(res.data.entries)).catch(() => setHistory([]));
  }
  useEffect(load, [id]);

  const formTeams = depts.find((d) => d.name === form.department)?.teams || [];

  function startEdit() {
    const f = {};
    EDIT_FIELDS.forEach((k) => { f[k] = employee[k] || ''; });
    if (f.dateOfBirth) f.dateOfBirth = String(f.dateOfBirth).slice(0, 10);
    if (f.dateOfJoining) f.dateOfJoining = String(f.dateOfJoining).slice(0, 10);
    // Aadhaar: only the last four are on file; the box stays empty (= unchanged).
    f.aadhaarNumber = '';
    f.roleCode = '';
    if (canEditCode) f.employeeCode = employee.employeeCode || '';
    setForm(f);
    setEditing(true);
    setError(''); setNotice('');
    // The live lists the full form offers: reporting managers and roles in the
    // caller's scope (Employee Management options), statuses / types / branches
    // from the masters. A role added in Role Catalog appears here by itself.
    Promise.all([
      api.get('/employees/management/options').then((r) => r.data).catch(() => ({})),
      api.get('/masters').then((r) => r.data).catch(() => ({})),
    ]).then(([o, m]) => setHrOptions({
      reportingManagers: o.reportingManagers || [],
      roles: (m.roles && m.roles.length ? m.roles : o.roleCatalog) || [],
      empTypes: m.employmentTypes || o.empTypes || [],
      statuses: m.employmentStatuses || [],
      branches: m.branches || [],
      hasLogin: !!employee.userId,
    }));
  }

  // ?edit=1 (the Edit button on Employee Management) opens the full form at once.
  useEffect(() => {
    if (employee && canEdit && searchParams.get('edit') === '1' && !editing) {
      startEdit();
      const next = new URLSearchParams(searchParams); next.delete('edit'); setSearchParams(next, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee, canEdit]);

  async function saveEdit(e) {
    e.preventDefault();
    setError(''); setNotice('');
    // The extra fields are checked BEFORE anything is saved, so a missing
    // required one is said in words and nothing half-saves.
    const extraWhy = extraRef.current ? extraRef.current.validate() : '';
    if (extraWhy) { setError(extraWhy); return; }
    setSaving(true);
    try {
      const { roleCode, employeeCode, ...body } = form;
      if (!body.aadhaarNumber) delete body.aadhaarNumber;
      // Employee ID first, through the checked endpoint (unique, audited); if it
      // is refused (e.g. already taken) nothing else is saved.
      const newCode = String(employeeCode || '').trim();
      if (canEditCode && newCode && newCode !== employee.employeeCode) {
        await api.put(`/employees/management/${id}/code`, { employeeCode: newCode, reason: 'Changed from the full Edit form' });
      }
      const res = await api.put(`/employees/${id}`, body);
      if (roleCode) await api.put(`/employees/management/${id}/roles`, { roleCode });
      // DOCUMENTS ARE PART OF THIS FORM: files picked in its Documents section
      // go up once the fields have saved. A failed file keeps the form open
      // with its reason and a Retry; the field changes are already saved.
      if (extraRef.current) await extraRef.current.save();
      const up = docsRef.current ? await docsRef.current.uploadAll(id) : { total: 0, failed: 0 };
      const saved = res.data?.designationWarning || 'Saved — every changed field is recorded in the history (old → new).';
      if (up.failed) {
        setError(`Changes saved, but ${up.failed} of ${up.total} document${up.total === 1 ? '' : 's'} could not be uploaded — see Documents below (Retry, or Save changes again).`);
      } else {
        setEditing(false);
        setNotice(up.total ? `${saved} ${up.total} document${up.total === 1 ? '' : 's'} uploaded.` : saved);
      }
      load();
    } catch (err) {
      setError(err.response?.data?.error || (!err.response && err.message) || 'The changes could not be saved.');
    } finally { setSaving(false); }
  }

  async function toggleOnboarding(index) {
    await api.patch(`/employees/${id}/onboarding/${index}`);
    load();
  }

  async function initiateOffboarding() {
    if (!confirm('Initiate offboarding for this employee?')) return;
    await api.post(`/employees/${id}/offboarding`);
    load();
  }

  async function toggleOffboarding(index) {
    await api.patch(`/employees/${id}/offboarding/${index}`);
    load();
  }

  async function decideChanges(action) {
    setError(''); setNotice(''); setBusy(action);
    try {
      await api.patch(`/employees/${id}/changes/${action}`,
        action === 'reject' ? { reason: reviewNote } : { note: reviewNote || undefined });
      setReviewNote('');
      setNotice(action === 'approve'
        ? 'Changes applied — the profile is now locked and the employee can no longer self-edit.'
        : 'Sent back to the employee with your reason.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That decision could not be saved.');
    } finally { setBusy(''); }
  }

  async function decideUnlock(action) {
    setError(''); setNotice(''); setBusy(action);
    try {
      const res = await api.patch(`/employees/${id}/unlock-request/${action}`,
        action === 'reject'
          ? { reason: unlockNote }
          : { note: unlockNote || undefined, hours: Number(grant.hours), section: grant.section });
      setUnlockNote('');
      setNotice(action === 'approve'
        ? `Edit access granted until ${new Date(res.data.unlockExpiresAt).toLocaleString('en-GB')}.`
        : 'Request declined — the employee has been given your reason.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That decision could not be saved.');
    } finally { setBusy(''); }
  }

  // Re-issue the single-use sign-in link. Any earlier link stops working.
  async function sendCredentials() {
    setError(''); setNotice(''); setCredentials(null); setBusy('credentials');
    try {
      const res = await api.post(`/employees/${id}/send-credentials`);
      setCredentials(res.data.credentials);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'The sign-in details could not be issued.');
    } finally { setBusy(''); }
  }

  async function toggleLock() {
    await api.patch(`/employees/${id}/toggle-lock`);
    load();
  }

  // HR opening the profile without waiting to be asked. The window, the
  // section and the reason are all recorded against the employee.
  async function submitGrant(e) {
    e.preventDefault();
    setError(''); setNotice(''); setBusy('grant');
    try {
      const res = await api.post(`/employees/${id}/grant-edit-access`, {
        hours: Number(grant.hours), section: grant.section, reason: grant.reason,
      });
      setNotice(`Edit access granted for ${res.data.grantedHours}h (${res.data.unlockGrantSection}) — expires ${new Date(res.data.unlockExpiresAt).toLocaleString('en-GB')}.`);
      setGrant({ open: false, hours: 48, section: 'All fields', reason: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Edit access could not be granted.');
    } finally { setBusy(''); }
  }

  async function togglePause() {
    await api.patch(`/employees/${id}/toggle-pause`);
    load();
  }

  async function deleteEmployee() {
    if (!confirm(`Permanently delete ${employee.name}? This removes their attendance, leave, payslip and other records too. This can't be undone.`)) return;
    await api.delete(`/employees/${id}`);
    navigate('/employees');
  }

  if (!employee) return <div className="small-muted">Loading…</div>;

  const onboardingDone = employee.onboardingTasks ? employee.onboardingTasks.filter((t) => t.completed).length : 0;
  const onboardingTotal = employee.onboardingTasks ? employee.onboardingTasks.length : 0;
  const onboardingPct = onboardingTotal ? Math.round((onboardingDone / onboardingTotal) * 100) : 0;

  return (
    <div>
      <Link className="small-muted" to="/employees">← Back to employees</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <h1>{employee.name}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`status ${employee.employmentStatus === 'Active' ? 'priority-low' : ['Exited', 'Relieved'].includes(employee.employmentStatus) ? 'priority-high' : ''}`}>{employee.employmentStatus}</span>
          <span className={`status ${STATUS_BADGE[employee.profileStatus] || ''}`}>{statusLabel(employee.profileStatus)}</span>
          {/* hrms-24 §3 — this person's summary (profile, attendance, leave,
              learning, assets, payslips for the current year). The server
              checks Employee Management export + scope, or that it is you. */}
          <ExportMenu
            url={`/insights/employee/${employee.id}/summary`}
            params={{ range: 'this_year' }}
            label="Export summary"
            note="Current year · Excel, CSV or PDF"
          />
          {canEdit && !editing && <button className="btn btn-sm btn-primary" onClick={startEdit}>Edit</button>}
          {isAdmin && <button className="btn btn-sm" onClick={togglePause}>{employee.employmentStatus === 'On Probation' ? 'Resume' : 'Pause'}</button>}
          {/* Grant Edit Access is the considered version of this button: a
              window, a section and a reason, all recorded. Lock stays as the
              immediate way to close a profile again. */}
          {isHR && employee.isLocked && (
            <button className="btn btn-sm btn-primary" onClick={() => setGrant((g) => ({ ...g, open: !g.open }))}>
              Grant Edit Access
            </button>
          )}
          {isAdmin && employee.isLocked === false && <button className="btn btn-sm" onClick={toggleLock}>Lock</button>}
          {isAdmin && employee.isLocked === true && <button className="btn btn-sm" onClick={toggleLock}>Unlock now</button>}
          {isAdmin && employee.user && (
            <button className="btn btn-sm" disabled={busy === 'credentials'} onClick={sendCredentials}>
              {busy === 'credentials' ? 'Sending…' : 'Send sign-in details'}
            </button>
          )}
          {isAdmin && <button className="btn btn-sm" onClick={deleteEmployee}>Delete</button>}
        </div>
      </div>

      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}
      {credentials && (
        <div className="notice" style={{ marginBottom: 12, borderColor: credentials.sent ? undefined : 'var(--warn)' }}>
          <div><b>Sign-in details:</b> {credentials.status}</div>
          {!credentials.sent && credentials.link && (
            <div className="small-muted" style={{ marginTop: 6, wordBreak: 'break-all' }}>
              Nothing was emailed. Pass this single-use link to {employee.name} yourself — it is shown once and
              expires {credentials.expiresAt ? new Date(credentials.expiresAt).toLocaleString('en-GB') : 'shortly'}:
              <br />{credentials.link}
            </div>
          )}
        </div>
      )}

      {/* GRANT EDIT ACCESS — not Edit Scope. This reopens ONE employee's own
          profile for a bounded time; it never widens what anybody can see. */}
      {grant.open && isHR && (
        <form className="card section" onSubmit={submitGrant} style={{ borderColor: 'var(--teal)' }}>
          <h3>Grant edit access — {employee.name}</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            This temporarily unlocks <b>this employee&apos;s own profile</b> so they can correct it. It does not change
            which records they can see — that is <b>Edit scope</b>, on Administration → Users.
          </div>
          <div className="grid-2">
            <label className="field">
              <span>Section to open</span>
              <Combo value={grant.section} onChange={(e) => setGrant({ ...grant, section: e.target.value })}>
                {(config?.editAccessSections || ['All fields']).map((s) => <option key={s}>{s}</option>)}
              </Combo>
            </label>
            <label className="field">
              <span>Access window (hours)</span>
              <input type="number" min="1" max="720" value={grant.hours}
                onChange={(e) => setGrant({ ...grant, hours: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Reason (recorded against the employee)</span>
            <input required value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })}
              placeholder="e.g. Bank details changed after the branch merger" />
          </label>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy === 'grant' || !grant.reason.trim()}>
            {busy === 'grant' ? 'Granting…' : 'Grant edit access'}
          </button>{' '}
          <button className="btn btn-sm" type="button" onClick={() => setGrant({ ...grant, open: false })}>Cancel</button>
        </form>
      )}

      {/* The recorded grant: which employee, which section, why, start, expiry
          and who granted it. */}
      {employee.unlockedAt && (
        <div className="card section">
          <h3 style={{ fontSize: 13 }}>Last edit-access grant</h3>
          <div className="kv"><span className="k">Section</span><span>{employee.unlockGrantSection || 'All fields'}</span></div>
          <div className="kv"><span className="k">Reason</span><span>{employee.unlockGrantReason || '—'}</span></div>
          <div className="kv"><span className="k">Unlocked by</span><span>{employee.unlockedByName || '—'}</span></div>
          <div className="kv"><span className="k">Unlocked at</span><span>{new Date(employee.unlockedAt).toLocaleString('en-GB')}</span></div>
          <div className="kv"><span className="k">Access expires</span>
            <span>{employee.unlockExpiresAt ? new Date(employee.unlockExpiresAt).toLocaleString('en-GB') : 'Closed (spent or re-locked)'}</span></div>
        </div>
      )}

      {/* THE REVIEW SURFACE — field by field, from → to, with a reason on the
          way back. Approving applies the values AND locks the profile; the
          server is what refuses the employee's next edit, not a disabled input. */}
      {employee.pendingChanges && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Profile submitted — awaiting review</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            {employee.name} submitted {employee.pendingChanges.length} change(s). Approving writes them onto the
            record and locks the profile — after that they can only edit again if you grant an unlock request.
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Field</th><th>Current</th><th>Submitted</th></tr></thead>
              <tbody>
                {employee.pendingChanges.map((c, i) => (
                  <tr key={i}>
                    <td>{c.label || c.field}</td>
                    <td className="cell-muted">{c.from || '—'}</td>
                    <td><b>{c.to}</b></td>
                  </tr>
                ))}
                {employee.pendingChanges.length === 0 && (
                  <tr><td colSpan="3" className="small-muted">
                    No field changes — they confirmed the record as it stands. Check their documents below.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {isAdmin && (
            <div style={{ marginTop: 10 }}>
              <label className="field">
                <span>Note to the employee (required when sending back)</span>
                <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="e.g. IFSC code doesn't match the bank name" />
              </label>
              <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => decideChanges('approve')}>
                Approve &amp; lock profile
              </button>{' '}
              <button className="btn btn-sm" disabled={!!busy || !reviewNote.trim()} onClick={() => decideChanges('reject')}>
                Send back with reason
              </button>
            </div>
          )}
        </div>
      )}

      {!employee.pendingChanges && employee.reviewDecision && (
        <div className="card section">
          <h3 style={{ fontSize: 13 }}>Last profile review</h3>
          <div className="kv"><span className="k">Decision</span>
            <span className={`status ${employee.reviewDecision === 'Approved' ? 'priority-low' : 'priority-medium'}`}>{employee.reviewDecision}</span></div>
          <div className="kv"><span className="k">By</span>
            <span>{employee.reviewedByName || '—'}{employee.reviewedAt ? ` · ${new Date(employee.reviewedAt).toLocaleString('en-GB')}` : ''}</span></div>
          {employee.reviewNote && <div className="kv"><span className="k">Note</span><span>{employee.reviewNote}</span></div>}
        </div>
      )}

      {employee.unlockRequestStatus === 'Pending' && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Edit access requested</h3>
          <div className="kv"><span className="k">Reason</span><span>{employee.unlockRequestReason}</span></div>
          <div className="small-muted">Request {employee.unlockRequestCount} of 3 for this employee (lifetime cap).</div>
          {isAdmin && (
            <div style={{ marginTop: 10 }}>
              <label className="field">
                <span>Note to the employee (required when declining)</span>
                <input value={unlockNote} onChange={(e) => setUnlockNote(e.target.value)}
                  placeholder="e.g. Approved — update the bank details only" />
              </label>
              <div className="grid-2">
                <label className="field">
                  <span>Section to open</span>
                  <Combo value={grant.section} onChange={(e) => setGrant({ ...grant, section: e.target.value })}>
                    {(config?.editAccessSections || ['All fields']).map((s) => <option key={s}>{s}</option>)}
                  </Combo>
                </label>
                <label className="field">
                  <span>Access window (hours)</span>
                  <input type="number" min="1" max="720" value={grant.hours}
                    onChange={(e) => setGrant({ ...grant, hours: e.target.value })} />
                </label>
              </div>
              <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => decideUnlock('approve')}>
                Grant edit access ({grant.hours}h)
              </button>{' '}
              <button className="btn btn-sm" disabled={!!busy || !unlockNote.trim()} onClick={() => decideUnlock('reject')}>
                Decline with reason
              </button>
            </div>
          )}
        </div>
      )}

      {!employee.isLocked && employee.unlockExpiresAt && new Date(employee.unlockExpiresAt) > new Date() && (
        <div className="notice" style={{ marginBottom: 12 }}>
          🔓 Edit access is open until <b>{new Date(employee.unlockExpiresAt).toLocaleString('en-GB')}</b>.
          It closes when they submit, or at that time — whichever is first.
        </div>
      )}

      {editing ? (
        <form className="card section" onSubmit={saveEdit}>
          {/* THE SAME FORM THE EMPLOYEE FILLS IN — components/EmployeeProfileForm.jsx.
              HR writes every field; department, seat and team keep their own
              controls (below) because a change there moves the login and the seat. */}
          <EmployeeProfileForm
            mode="hr"
            form={form}
            setForm={setForm}
            employee={employee}
            isAdmin={isAdmin}
            canEditCode={canEditCode}
            hrOptions={hrOptions}
            documents={(
              <EmployeeDocuments
                ref={docsRef}
                embedded
                uploadOnSave
                employeeId={employee.id}
                onChange={setPendingDocs}
                intro="Several files per type is fine. The employee sees these on their own profile too."
              />
            )}
            hrEmployment={(
              <>
                {/* DEPARTMENT IS EDITABLE HERE.
                    It used to be a greyed-out box captioned "use Transfer to
                    change", which told you where to go rather than letting you do
                    it. The server now does everything Transfer does when this
                    changes: the login's ATS scope follows, the team is cleared
                    (a team belongs to a department), and a seat from the old
                    department is vacated — its tenure closed, not deleted.

                    Transfer still exists, and is still the right button for a
                    reorganisation: it takes a REASON and records it. This is for
                    a correction. */}
                <label className="field">
                  <span>Department</span>
                  <Combo
                    creatable
                    value={form.department}
                    onChange={(e) => setForm({
                      // Team and seat both belong to the old department, so both
                      // are cleared the moment it changes — otherwise the form
                      // would post a Medical employee into an Education seat.
                      ...form, department: e.target.value, team: '', position: '',
                    })}
                  >
                    <option value="">Select department</option>
                    {depts.map((d) => <option key={d.id || d.name} value={d.name}>{d.name}</option>)}
                  </Combo>
                  {form.department !== employee.department && (
                    <span className="small-muted">
                      Moving from {employee.department || '—'} to {form.department || '—'}. Their ATS scope
                      moves with them, their team is cleared, and a seat in {employee.department || 'the old department'} is vacated.
                    </span>
                  )}
                </label>
                {/* THE SEAT. Department, designation and position are the three
                    fields an employee may never set for themselves — so this is
                    where an admin sets them, on the record, rather than on a
                    separate Positions screen.

                    Only this department's seats are offered, and a seat somebody
                    else holds is listed and labelled rather than hidden: a missing
                    code reads as "no such seat", which is a different fact. The
                    server refuses a taken one either way. Creatable — typing a new
                    code makes the seat on save. */}
                <label className="field">
                  <span>Position <i style={{ fontWeight: 400 }}>(the seat, not the person)</i></span>
                  <Combo
                    creatable
                    // The seats listed came from the SAVED department. Once the
                    // department picker has been changed they are the wrong
                    // department's seats, and offering them would invite exactly
                    // the mistake this field exists to prevent. Save first.
                    disabled={form.department !== employee.department}
                    value={form.position}
                    onChange={(e) => setForm({ ...form, position: e.target.value })}
                  >
                    <option value="">No seat</option>
                    {(employee.positionOptions || []).map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.code}
                        {r.name ? ` · ${r.name}` : ''}
                        {r.holder ? ` · held by ${r.holder}` : ''}
                      </option>
                    ))}
                  </Combo>
                  {form.department !== employee.department && (
                    <span className="small-muted">
                      Save the department change first — then this will list {form.department || 'the new department'}&apos;s seats.
                    </span>
                  )}
                </label>
                {formTeams.length > 0 && (
                  <label className="field">
                    <span>Team</span>
                    <Combo creatable value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })}>
                      <option value="">No team</option>
                      {formTeams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                    </Combo>
                  </label>
                )}
              </>
            )}
          />
          <ExtraFields ref={extraRef} employeeId={employee.id} editable />

          {/* Save / Cancel close the WHOLE form — fields and documents — and
              stay in reach at the bottom of the view while it scrolls. */}
          <div className="emp-form-foot">
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button className="btn btn-sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
            {pendingDocs > 0 && (
              <span className="small-muted">{pendingDocs} document{pendingDocs === 1 ? '' : 's'} will upload when you save.</span>
            )}
          </div>
        </form>
      ) : (
        <div className="two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Profile — {employee.profileCompletionPct}% complete</h3>
            <div className="kv"><span className="k">Employee Code</span><span>{employee.employeeCode}</span></div>
            <div className="kv"><span className="k">Email</span><span>{employee.email || '—'}</span></div>
            <div className="kv"><span className="k">Phone</span><span>{employee.phone || '—'}</span></div>
            <div className="kv"><span className="k">Department</span><span>{employee.department || '—'}</span></div>
            <div className="kv"><span className="k">Team</span><span>{employee.team || '—'}</span></div>
            <div className="kv"><span className="k">Branch</span><span>{employee.branch || '—'}</span></div>
            <div className="kv"><span className="k">Designation</span><span>{employee.designation || '—'}</span></div>
            <div className="kv"><span className="k">Shift</span><span>{employee.shift || '—'}</span></div>
            <div className="kv"><span className="k">Employee Type</span><span>{employee.employeeType || '—'}</span></div>
            <div className="kv"><span className="k">Gender</span><span>{employee.gender || '—'}</span></div>
            <div className="kv"><span className="k">Blood Group</span><span>{employee.bloodGroup || '—'}</span></div>
            <div className="kv"><span className="k">Date of Joining</span><span>{employee.dateOfJoining ? new Date(employee.dateOfJoining).toLocaleDateString() : '—'}</span></div>
            <div className="kv"><span className="k">Reporting Manager</span><span>{employee.reportingManager?.name || '—'}</span></div>
          </div>

          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>Address & Emergency Contact</h3>
            <div className="kv"><span className="k">Address</span><span>{[employee.addressLine1, employee.city, employee.state, employee.postalCode].filter(Boolean).join(', ') || employee.address || '—'}</span></div>
            <div className="kv"><span className="k">Emergency Contact</span><span>{employee.emergencyContactName || '—'} {employee.emergencyContactRelation ? `(${employee.emergencyContactRelation})` : ''} {employee.emergencyContactPhone ? `— ${employee.emergencyContactPhone}` : ''}</span></div>
            <div className="kv"><span className="k">Login Account</span><span>{employee.user ? `${employee.user.name} · ${employee.user.role}` : 'Not linked'}</span></div>
            <div className="kv"><span className="k">Sign-in details</span>
              <span>{employee.credentialsSentStatus || 'Not issued yet'}
                {employee.credentialsSentAt ? ` · ${new Date(employee.credentialsSentAt).toLocaleString('en-GB')}` : ''}</span></div>

            <h3 style={{ fontSize: 13, margin: '14px 0 8px' }}>Bank & Statutory <span className="small-muted">(restricted)</span></h3>
            <div className="kv"><span className="k">Bank</span><span>{employee.bankName ? `${employee.bankName} · ${employee.bankAccountNumber || '—'}` : '—'}</span></div>
            <div className="kv"><span className="k">PAN</span><span>{employee.panNumber || '—'}</span></div>
            <div className="kv"><span className="k">UAN / PF / ESI</span><span>{employee.uanNumber || '—'} / {employee.pfNumber || '—'} / {employee.esiNumber || '—'}</span></div>

            <h3 style={{ fontSize: 13, margin: '14px 0 8px' }}>Education & Experience</h3>
            <div className="kv"><span className="k">Employment Type</span><span>{employee.employmentExperience || '—'}</span></div>
            <div className="kv"><span className="k">Education</span><span>{employee.educationDetails || '—'}</span></div>
            <div className="kv"><span className="k">Skills</span><span>{employee.skills || '—'}</span></div>
          </div>
        </div>
      )}

      {/* DOCUMENTS on the record VIEW, for every role that can open it. While
          editing they are a section INSIDE the Edit form above instead. The
          component asks the server what this caller may do: HR uploads and
          deletes, a view-only Manager / Assistant Manager views and downloads,
          and a role the server refuses (403) sees no section at all. */}
      {!editing && <ExtraFields employeeId={employee.id} />}
      {!editing && (
        <EmployeeDocuments
          employeeId={employee.id}
          intro="Upload as many as needed — several of one type is fine. The employee sees these on their own profile too."
        />
      )}

      <div className="card section">
        <h3>Onboarding checklist — {onboardingPct}%</h3>
        {(employee.onboardingTasks || []).map((t, i) => (
          <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 13.5 }}>
            <input type="checkbox" checked={t.completed} disabled={!isHR} onChange={() => toggleOnboarding(i)} style={{ width: 'auto' }} />
            <span style={{ textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? 'var(--ink-soft)' : 'var(--ink)' }}>{t.task}</span>
          </label>
        ))}
      </div>

      {isHR && !employee.offboardingStatus && !['Exited', 'Relieved'].includes(employee.employmentStatus) && (
        <div className="card section">
          <h3>Offboarding</h3>
          <button className="btn btn-sm" onClick={initiateOffboarding}>Initiate Offboarding</button>
        </div>
      )}

      {/* AUDIT HISTORY — Employee · Field · Old Value · New Value ·
          Changed By · Changed At · Reason · Approval Status, with the
          approver recorded once HR has decided. */}
      {isHR && (
        <div className="card section">
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 13 }}>Audit history {history ? `(${history.length})` : ''}</h3>
            <button className="btn btn-sm" onClick={() => setShowHistory((s) => !s)}>
              {showHistory ? 'Hide' : 'Show'}
            </button>
          </div>
          {showHistory && (history === null ? <div className="small-muted">Loading…</div> : history.length === 0
            ? <div className="small-muted">Nothing recorded against this employee yet.</div>
            : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Field</th><th>Old Value</th><th>New Value</th><th>Changed By</th>
                      <th>Changed At</th><th>Reason</th><th>Approval Status</th><th>Approved By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>{h.label || <span className="cell-muted">{h.action}</span>}</td>
                        <td className="cell-muted">{h.from || '—'}</td>
                        <td>{h.to || '—'}</td>
                        <td className="cell-muted">{h.changedBy}</td>
                        <td className="cell-muted">{new Date(h.changedAt).toLocaleString('en-GB')}</td>
                        <td className="cell-muted">{h.reason || '—'}</td>
                        <td>{h.approvalStatus
                          ? <span className={`status ${h.approvalStatus === 'Approved' ? 'approved' : h.approvalStatus === 'Rejected' ? 'rejected' : 'pending'}`}>{h.approvalStatus}</span>
                          : <span className="cell-muted">—</span>}</td>
                        <td className="cell-muted">{h.approvedBy || '—'}
                          {h.approvedAt ? ` · ${new Date(h.approvedAt).toLocaleDateString('en-GB')}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
      )}

      {employee.offboardingStatus && (
        <div className="card section">
          <h3>Offboarding — <span className={`status ${employee.offboardingStatus === 'Cleared' ? 'priority-low' : ''}`}>{employee.offboardingStatus}</span></h3>
          {(employee.offboardingTasks || []).map((t, i) => (
            <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 13.5 }}>
              <input type="checkbox" checked={t.completed} disabled={!isHR} onChange={() => toggleOffboarding(i)} style={{ width: 'auto' }} />
              <span style={{ textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? 'var(--ink-soft)' : 'var(--ink)' }}>{t.task}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

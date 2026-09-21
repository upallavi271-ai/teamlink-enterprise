import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { isAdmin as hasAdminAccess, isHR as hasHrmsAdmin } from '../permissions';
import { STATUS_BADGE, statusLabel } from '../components/ProfileStatusBanner.jsx';
import Combo from '../components/Combo.jsx';


const EDIT_FIELDS = [
  'name', 'email', 'phone', 'department', 'team', 'designation', 'location', 'employmentStatus', 'employeeType',
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'addressType',
  'addressLine1', 'addressLine2', 'city', 'district', 'state', 'country', 'postalCode', 'bloodGroup',
  'branch', 'shift', 'employmentExperience', 'educationDetails', 'skills',
  'bankName', 'bankAccountNumber', 'ifscCode', 'panNumber', 'aadhaarNumber', 'uanNumber', 'pfNumber', 'esiNumber',
];

export default function EmployeeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const isAdmin = hasAdminAccess(user);
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
    setForm(f);
    setEditing(true);
  }

  async function saveEdit(e) {
    e.preventDefault();
    await api.put(`/employees/${id}`, form);
    setEditing(false);
    load();
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
          {isAdmin && !editing && <button className="btn btn-sm" onClick={startEdit}>Edit</button>}
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
          <h3>Personal Information</h3>
          <div className="grid-2">
            <label className="field"><span>Full name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Phone</span><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label className="field"><span>Email</span><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field">
              <span>Blood Group</span>
              <Combo value={form.bloodGroup} onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}>
                <option value="">Select</option>
                {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b}>{b}</option>)}
              </Combo>
            </label>
          </div>

          <h3 style={{ marginTop: 14 }}>Address</h3>
          <div className="grid-2">
            <label className="field">
              <span>Address Type</span>
              <Combo value={form.addressType} onChange={(e) => setForm({ ...form, addressType: e.target.value })}>
                <option value="">Select type</option><option>Current</option><option>Permanent</option>
              </Combo>
            </label>
            <label className="field"><span>Address Line 1</span><input value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} /></label>
            <label className="field"><span>Address Line 2</span><input value={form.addressLine2} onChange={(e) => setForm({ ...form, addressLine2: e.target.value })} /></label>
            <label className="field"><span>City / Town</span><input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label>
            <label className="field"><span>District</span><input value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} /></label>
            <label className="field"><span>State / Province</span><input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} /></label>
            <label className="field"><span>Country</span><input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></label>
            <label className="field"><span>Postal Code</span><input value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></label>
          </div>

          <h3 style={{ marginTop: 14 }}>Emergency Contact</h3>
          <div className="grid-2">
            <label className="field"><span>Name</span><input value={form.emergencyContactName} onChange={(e) => setForm({ ...form, emergencyContactName: e.target.value })} /></label>
            <label className="field"><span>Relation</span><input value={form.emergencyContactRelation} onChange={(e) => setForm({ ...form, emergencyContactRelation: e.target.value })} /></label>
            <label className="field"><span>Number</span><input value={form.emergencyContactPhone} onChange={(e) => setForm({ ...form, emergencyContactPhone: e.target.value })} /></label>
          </div>

          <h3 style={{ marginTop: 14 }}>Employment Details</h3>
          <div className="grid-2">
            <label className="field">
              <span>Department (use Transfer to change)</span>
              <input value={form.department} disabled />
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
            <label className="field">
              <span>Branch</span>
              <Combo creatable value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                <option value="">Select branch</option><option>Bengaluru</option><option>Chennai</option><option>Hyderabad</option>
              </Combo>
            </label>
            <label className="field"><span>Designation</span><input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></label>
            <label className="field"><span>Location</span><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
            <label className="field"><span>Shift</span><input value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })} /></label>
            {isAdmin && (
              <label className="field">
                <span>Status</span>
                <Combo value={form.employmentStatus} onChange={(e) => setForm({ ...form, employmentStatus: e.target.value })}>
                  {['Active', 'On Probation', 'Notice Period', 'Exit Process', 'Relieved', 'Exited'].map((s) => <option key={s}>{s}</option>)}
                </Combo>
              </label>
            )}
          </div>

          <h3 style={{ marginTop: 14 }}>Bank & Statutory Details</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>Restricted — shown on payslips.</div>
          <div className="grid-2">
            <label className="field"><span>Bank name</span><input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></label>
            <label className="field"><span>Account number</span><input value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value })} /></label>
            <label className="field"><span>IFSC code</span><input value={form.ifscCode} onChange={(e) => setForm({ ...form, ifscCode: e.target.value })} /></label>
            <label className="field"><span>PAN number</span><input value={form.panNumber} onChange={(e) => setForm({ ...form, panNumber: e.target.value })} /></label>
            <label className="field"><span>Aadhaar number</span><input value={form.aadhaarNumber} onChange={(e) => setForm({ ...form, aadhaarNumber: e.target.value })} /></label>
            <label className="field"><span>UAN number</span><input value={form.uanNumber} onChange={(e) => setForm({ ...form, uanNumber: e.target.value })} /></label>
            <label className="field"><span>PF number</span><input value={form.pfNumber} onChange={(e) => setForm({ ...form, pfNumber: e.target.value })} /></label>
            <label className="field"><span>ESI number</span><input value={form.esiNumber} onChange={(e) => setForm({ ...form, esiNumber: e.target.value })} /></label>
          </div>

          <h3 style={{ marginTop: 14 }}>Education & Work Experience</h3>
          <div className="grid-2">
            <label className="field">
              <span>Employment Type</span>
              <Combo value={form.employmentExperience} onChange={(e) => setForm({ ...form, employmentExperience: e.target.value })}>
                <option>Fresher</option><option>Experienced</option>
              </Combo>
            </label>
            <label className="field"><span>Education details</span><input value={form.educationDetails} onChange={(e) => setForm({ ...form, educationDetails: e.target.value })} /></label>
            <label className="field"><span>Skills & certifications</span><input value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} /></label>
          </div>

          <div style={{ marginTop: 14 }}>
            <button className="btn btn-primary btn-sm" type="submit">Save changes</button>{' '}
            <button className="btn btn-sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
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

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasTeamOversight } from '../../permissions';

// Only STL/TL are restricted to their own department — Manager/Assistant
// Manager have cross-department oversight (matches backend/src/routes/employees.js).

const emptyForm = {
  phone: '', email: '', dateOfBirth: '', gender: '', bloodGroup: '',
  addressType: '', addressLine1: '', addressLine2: '', city: '', district: '', state: '', country: '', postalCode: '',
  emergencyContactName: '', emergencyContactPhone: '', emergencyContactRelation: '',
  branch: '', shift: '', employmentExperience: 'Fresher', educationDetails: '', skills: '',
  bankName: '', bankAccountNumber: '', ifscCode: '', panNumber: '', aadhaarNumber: '', uanNumber: '', pfNumber: '', esiNumber: '',
};

export default function MyProfile() {
  const { user } = useAuth();
  const isTeamLead = hasTeamOversight(user);
  const isDeptScoped = hasTeamOversight(user);
  const [employee, setEmployee] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState('');
  const [unlockReason, setUnlockReason] = useState('');
  const [unlockMessage, setUnlockMessage] = useState('');
  const [team, setTeam] = useState([]);

  function load() {
    api.get('/employees/me')
      .then((res) => {
        setEmployee(res.data);
        const f = {};
        Object.keys(emptyForm).forEach((k) => {
          if (!res.data[k]) { f[k] = k === 'employmentExperience' ? 'Fresher' : ''; return; }
          f[k] = k === 'dateOfBirth' ? String(res.data[k]).slice(0, 10) : res.data[k];
        });
        setForm(f);
      })
      .catch(() => setError('No employee record linked to this account.'));
    api.get('/employees/me/config').then((res) => setConfig(res.data));
    if (isTeamLead) {
      // Backend scopes this to the caller's own department for STL/TL; Manager
      // and Assistant Manager get every employee, company-wide.
      api.get('/employees').then((res) => setTeam(res.data)).catch(() => setTeam([]));
    }
  }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault();
    setMessage('');
    try {
      await api.put('/employees/me', form);
      setMessage('Submitted for HR review.');
      load();
    } catch (err) {
      setMessage(err.response?.data?.error || 'Could not submit.');
    }
  }

  async function requestUnlock(e) {
    e.preventDefault();
    setUnlockMessage('');
    try {
      await api.post('/employees/me/unlock-request', { reason: unlockReason });
      setUnlockMessage('Edit access requested — awaiting HR review.');
      setUnlockReason('');
      load();
    } catch (err) {
      setUnlockMessage(err.response?.data?.error || 'Could not submit request.');
    }
  }

  if (error) return <div className="empty small-muted">{error}</div>;
  if (!employee || !config) return <div className="small-muted">Loading…</div>;

  const awaitingReview = !!employee.pendingChanges;
  const locked = employee.isLocked && !awaitingReview;
  const editable = !employee.isLocked && !awaitingReview;
  const requestsUsed = employee.unlockRequestCount || 0;
  const requestsLeft = Math.max(0, config.unlockRequestLimit - requestsUsed);
  // The bounded window an approved unlock request grants. The server is what
  // enforces it (routes/employees.js enforceEditWindow); this only says so.
  const windowEndsAt = employee.unlockExpiresAt ? new Date(employee.unlockExpiresAt) : null;
  const windowOpen = editable && windowEndsAt && windowEndsAt > new Date();

  return (
    <div>
      <div className="page-head"><div><h1>My Profile</h1><div className="page-sub">{employee.name} · {employee.employeeCode} · {employee.department || 'No department yet'}</div></div></div>

      {awaitingReview && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Submitted — awaiting HR review</h3>
          <div className="small-muted">You submitted the following changes. You can't edit further until HR approves or sends them back.</div>
          {employee.pendingChanges.map((c, i) => (
            <div className="kv" key={i}><span className="k">{c.label}</span><span>{c.from || '—'} → {c.to}</span></div>
          ))}
        </div>
      )}

      {/* What HR decided. Previously the banner simply vanished and the
          employee was left guessing why their submission had not stuck. */}
      {!awaitingReview && employee.reviewDecision === 'Rejected' && (
        <div className="card section" style={{ borderColor: 'var(--danger, var(--warn))' }}>
          <h3>HR sent your profile back for edit</h3>
          <div className="kv"><span className="k">Reason</span><span>{employee.reviewNote || '—'}</span></div>
          <div className="kv"><span className="k">Reviewed by</span>
            <span>{employee.reviewedByName || 'HR'}{employee.reviewedAt ? ` · ${new Date(employee.reviewedAt).toLocaleString('en-GB')}` : ''}</span></div>
          <div className="small-muted" style={{ marginTop: 6 }}>Correct the details below and submit again.</div>
        </div>
      )}
      {!awaitingReview && employee.reviewDecision === 'Approved' && employee.isLocked && (
        <div className="notice" style={{ marginBottom: 12 }}>
          HR approved your profile{employee.reviewedByName ? ` (${employee.reviewedByName})` : ''}
          {employee.reviewedAt ? ` on ${new Date(employee.reviewedAt).toLocaleString('en-GB')}` : ''} and it is now locked.
          {employee.reviewNote ? ` Note: ${employee.reviewNote}` : ''}
        </div>
      )}
      {employee.unlockRequestStatus === 'Rejected' && locked && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Your last edit-access request was declined</h3>
          <div className="kv"><span className="k">HR&apos;s reason</span><span>{employee.unlockDecisionNote || '—'}</span></div>
        </div>
      )}
      {windowOpen && (
        <div className="notice" style={{ marginBottom: 12 }}>
          🔓 HR granted you edit access until <b>{windowEndsAt.toLocaleString('en-GB')}</b>
          {employee.unlockDecisionNote ? ` — ${employee.unlockDecisionNote}` : ''}. Submitting your changes
          closes the window; so does the deadline, whichever comes first.
        </div>
      )}

      {locked && (
        <div className="card section">
          <h3>Profile locked</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            Your profile was approved by HR and is now locked. To make further changes, request edit access below.
            {' '}({requestsLeft} of {config.unlockRequestLimit} requests remaining.) If HR agrees you get
            {' '}{config.unlockWindowHours || 48} hours to edit and re-submit — the profile locks again on approval.
          </div>
          {employee.unlockRequestStatus === 'Pending' ? (
            <div className="status priority-medium">Edit access requested ({employee.unlockRequestReason}) — awaiting HR review</div>
          ) : requestsLeft > 0 ? (
            <form onSubmit={requestUnlock}>
              <div className="grid-2">
                <label className="field">
                  <span>Reason for requesting edit access</span>
                  <select required value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)}>
                    <option value="">Select a reason</option>
                    {config.unlockRequestReasons.map((r) => <option key={r}>{r}</option>)}
                  </select>
                </label>
              </div>
              <button className="btn btn-primary btn-sm" type="submit">Request Edit Access</button>
              {unlockMessage && <span className="small-muted" style={{ marginLeft: 10 }}>{unlockMessage}</span>}
            </form>
          ) : (
            <div className="error-text">You've used all {config.unlockRequestLimit} edit requests. Please contact HR directly.</div>
          )}
        </div>
      )}

      <form className="card section" onSubmit={submit}>
        <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
          <h3>Personal Information</h3>
          <div className="grid-2">
            <label className="field"><span>Phone</span><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label className="field"><span>Email</span><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field"><span>Date of Birth</span><input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} /></label>
            <label className="field">
              <span>Gender</span>
              <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                <option value="">Select</option><option>Male</option><option>Female</option><option>Other</option>
              </select>
            </label>
            <label className="field">
              <span>Blood Group</span>
              <select value={form.bloodGroup} onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}>
                <option value="">Select</option>
                {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => <option key={b}>{b}</option>)}
              </select>
            </label>
          </div>

          <h3 style={{ marginTop: 14 }}>Address</h3>
          <div className="grid-2">
            <label className="field">
              <span>Address Type</span>
              <select value={form.addressType} onChange={(e) => setForm({ ...form, addressType: e.target.value })}>
                <option value="">Select type</option><option>Current</option><option>Permanent</option>
              </select>
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

          <h3 style={{ marginTop: 14 }}>Work Details</h3>
          <div className="grid-2">
            <label className="field">
              <span>Branch</span>
              <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                <option value="">Select branch</option><option>Bengaluru</option><option>Chennai</option><option>Hyderabad</option>
              </select>
            </label>
            <label className="field"><span>Shift</span><input value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })} /></label>
            <label className="field">
              <span>Employment Type</span>
              <select value={form.employmentExperience} onChange={(e) => setForm({ ...form, employmentExperience: e.target.value })}>
                <option>Fresher</option><option>Experienced</option>
              </select>
            </label>
            <label className="field"><span>Education details</span><input value={form.educationDetails} onChange={(e) => setForm({ ...form, educationDetails: e.target.value })} /></label>
            <label className="field"><span>Skills & certifications</span><input value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} /></label>
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

          {editable && <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} type="submit">Submit for Review</button>}
          {message && <span className="small-muted" style={{ marginLeft: 10 }}>{message}</span>}
        </fieldset>
      </form>
      {!editable && <div className="small-muted" style={{ marginTop: -10, marginBottom: 16 }}>🔒 This form is locked and can't be edited right now.</div>}

      <div className="card">
        <h3 style={{ fontSize: 13, marginBottom: 8 }}>Read-only details (set by HR)</h3>
        <div className="kv"><span className="k">Department</span><span>{employee.department || '—'}</span></div>
        <div className="kv"><span className="k">Team</span><span>{employee.team || '—'}</span></div>
        <div className="kv"><span className="k">Designation</span><span>{employee.designation || '—'}</span></div>
        <div className="kv"><span className="k">Reporting Manager</span><span>{employee.reportingManager?.name || '—'}</span></div>
        <div className="kv"><span className="k">Joining Date</span><span>{employee.dateOfJoining ? new Date(employee.dateOfJoining).toLocaleDateString() : '—'}</span></div>
      </div>

      {isTeamLead && (
        <div className="card section">
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 13 }}>{isDeptScoped ? `My Department — ${employee.department || 'Unassigned'}` : 'All Employees (cross-department oversight)'}</h3>
            <Link className="btn btn-sm" to="/employees">Open Employee Management</Link>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Code</th><th>Designation</th><th>Status</th><th>Profile Stage</th></tr></thead>
              <tbody>
                {team.map((e) => (
                  <tr key={e.id} className="row-link">
                    <td><Link to={`/employees/${e.id}`}>{e.name}</Link></td>
                    <td>{e.employeeCode}</td>
                    <td>{e.designation || '—'}</td>
                    <td><span className={`status ${e.employmentStatus === 'Active' ? 'priority-low' : ''}`}>{e.employmentStatus}</span></td>
                    <td><span className={`status ${e.profileStage === 'Locked' ? 'priority-low' : e.profileStage === 'Pending Review' ? 'priority-medium' : ''}`}>{e.profileStage === 'Locked' ? '🔒 Locked' : e.profileStage}</span></td>
                  </tr>
                ))}
                {team.length === 0 && <tr><td colSpan="5" className="small-muted">No department employees yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasTeamOversight } from '../../permissions';
import ProfileStatusBanner, { STATUS_BADGE, statusLabel } from '../../components/ProfileStatusBanner.jsx';
import Combo from '../../components/Combo.jsx';
import EmployeeProfileForm, { SELF_FIELDS, formFromEmployee } from '../../components/EmployeeProfileForm.jsx';
import EmployeeDocuments from '../../components/EmployeeDocuments.jsx';
import EmailVerify from '../../components/EmailVerify.jsx';
import EmployeePhoto from '../../components/EmployeePhoto.jsx';
import ExportMenu from '../../components/ExportMenu.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ReferPanel from '../../components/referrals/ReferPanel.jsx'; // ATS-100 B6.1

// Only STL/TL are restricted to their own department — Manager/Assistant
// Manager have cross-department oversight (matches backend/src/routes/employees.js).

// MY EMPLOYEE PROFILE — the employee's COMPLETE record, in the same form HR
// edits (components/EmployeeProfileForm.jsx), not a summary card. The fields
// they may provide are SELF_FIELDS; everything HR owns is on the form too,
// shown and disabled.
//
// NO aadhaarNumber among SELF_FIELDS. The full number is never typed into a
// field that gets saved — Section 29 of the Aadhaar Act forbids retaining it.
// It is entered in the verification panel below, used, and dropped; only the
// last four digits are kept. See backend/src/utils/employeeVerification.js.
//
// SUBMIT LOCKS IT. PUT /me parks the submission as pendingChanges and the
// profile becomes Pending Review, so the server refuses the next self-edit
// from that moment; HR's approval locks it for good, a send-back reopens it,
// and after that only an edit-access grant does. This is the existing
// profile workflow — the screen just shows every section of it read-only.

export default function MyProfile() {
  const { user } = useAuth();
  const isTeamLead = hasTeamOversight(user);
  const isDeptScoped = hasTeamOversight(user);
  const [employee, setEmployee] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => formFromEmployee(null, SELF_FIELDS));
  const [message, setMessage] = useState('');
  const [unlockReason, setUnlockReason] = useState('');
  const [unlockMessage, setUnlockMessage] = useState('');
  // The Documents section inside the profile form; Submit uploads its files.
  const docsRef = useRef(null);
  const [team, setTeam] = useState([]);
  // Identity verification. `vf` is the form, `vr` the server's answer to the
  // last start/confirm — kept apart so a stale message never sits under a
  // fresh form.
  const [vf, setVf] = useState({ kind: 'MOBILE', mobile: '', aadhaar: '', otp: '' });
  const [vr, setVr] = useState(null);
  const [vbusy, setVbusy] = useState('');
  const [verr, setVerr] = useState('');
  // The lead's team table: Search · Role · Status · Profile status, sorted,
  // paged 25 / 50 / 100 (hooks — set up before the loading returns below).
  const teamLf = useListFilters(team, [
    { key: 'q', type: 'search', placeholder: 'Search name or employee ID…', get: (e) => `${e.name || ''} ${e.employeeCode || ''}` },
    { key: 'role', label: 'Role', primary: true, get: (e) => e.designation },
    { key: 'status', label: 'Status', primary: true, get: (e) => e.employmentStatus },
    { key: 'profile', label: 'Profile status', primary: true, allLabel: 'All profile statuses', get: (e) => (e.profileStatus ? statusLabel(e.profileStatus) : '') },
  ], {
    sorts: [
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
      { key: 'code', label: 'Employee ID', cmp: (a, b) => String(a.employeeCode || '').localeCompare(String(b.employeeCode || ''), undefined, { numeric: true }) },
    ],
  });
  const teamPage = usePaged(teamLf.rows);

  function load() {
    api.get('/employees/me')
      .then((res) => {
        setEmployee(res.data);
        const f = formFromEmployee(res.data, SELF_FIELDS);
        // Awaiting review, the form shows what they SUBMITTED, not the record
        // as it stood before — that is the form they are being asked about.
        (res.data.pendingChanges || []).forEach((c) => {
          if (Object.prototype.hasOwnProperty.call(f, c.field)) f[c.field] = c.to ?? '';
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

  async function startVerify(e) {
    e.preventDefault();
    setVbusy('start'); setVerr(''); setVr(null);
    try {
      const res = await api.post('/employees/me/verify/start', {
        kind: vf.kind, mobile: vf.mobile, aadhaar: vf.aadhaar,
      });
      setVr(res.data);
      // The Aadhaar number has done its job. It is not kept in the form, in
      // component state, or anywhere else on this machine.
      setVf((f) => ({ ...f, aadhaar: '', otp: '' }));
    } catch (err) {
      setVerr(err.response?.data?.error || 'Could not start the verification.');
    } finally { setVbusy(''); }
  }

  async function confirmVerify(e) {
    e.preventDefault();
    setVbusy('confirm'); setVerr('');
    try {
      const res = await api.post('/employees/me/verify/confirm', { otp: vf.otp });
      setVr({ ...res.data, done: true });
      setVf((f) => ({ ...f, otp: '' }));
      load();
    } catch (err) {
      setVerr(err.response?.data?.error || 'Could not verify that code.');
    } finally { setVbusy(''); }
  }

  async function submit(e) {
    e.preventDefault();
    setMessage('');
    // eslint-disable-next-line no-alert
    if (!confirm('Submit your employee profile to HR? The form locks as soon as it is submitted — you can still view it, but further changes need HR to reopen it.')) return;
    try {
      // DOCUMENTS ARE PART OF THIS FORM: the files picked in its Documents
      // section go first, while the form is still open. If one fails, nothing
      // is submitted — the form stays open with the reason and a Retry.
      if (docsRef.current) {
        const bad = docsRef.current.validate();
        if (bad) { setMessage(bad); return; }
        const up = await docsRef.current.uploadAll(employee.id);
        if (up.failed) {
          setMessage(`${up.failed} of ${up.total} document${up.total === 1 ? '' : 's'} could not be uploaded — see Documents above. Nothing was submitted yet.`);
          return;
        }
      }
      await api.put('/employees/me', form);
      setMessage('Submitted for HR review — your form is now locked.');
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
      <div className="page-head">
        <div>
          <h1>My Employee Profile</h1>
          <div className="page-sub">{employee.name} · {employee.employeeCode} · {employee.department || 'No department yet'}</div>
        </div>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span className={`status ${STATUS_BADGE[employee.profileStatus] || ''}`}>{statusLabel(employee.profileStatus)}</span>
          {/* hrms-24 §3 — your own summary; no export permission needed. */}
          {employee.id && (
            <ExportMenu url={`/insights/employee/${employee.id}/summary`} params={{ range: 'this_year' }} label="Export my summary" note="Current year · your own data" />
          )}
        </span>
      </div>
      {/* hrms-24 §12 — HR reset this password; the owner changes it on Profile. */}
      {user?.passwordStatus?.passwordResetRequired && (
        <div className="notice amber" style={{ display: 'block' }}>
          HR reset your password. <Link to="/admin/profile">Change it now</Link> — Profile → Change password.
        </div>
      )}

      {/* The same words the dashboard shows, from the same component — an
          employee cannot be told two different things about one profile. */}
      <ProfileStatusBanner variant="page" employee={employee} />

      {awaitingReview && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Submitted — awaiting HR review</h3>
          <div className="small-muted">
            {employee.pendingChanges.length
              ? 'You submitted the following changes. Your form is locked until HR approves or sends it back — the full form is below, read-only.'
              : 'You confirmed your profile without changing any field. Your form is locked until HR approves or sends it back — the full form is below, read-only.'}
          </div>
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
      {!awaitingReview && employee.reviewDecision === 'Approved' && employee.isLocked && employee.reviewNote && (
        <div className="notice" style={{ marginBottom: 12 }}>HR&apos;s note: {employee.reviewNote}</div>
      )}
      {employee.unlockRequestStatus === 'Rejected' && locked && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Your last edit-access request was declined</h3>
          <div className="kv"><span className="k">HR&apos;s reason</span><span>{employee.unlockDecisionNote || '—'}</span></div>
        </div>
      )}
      {/* The grant is a RECORD, not just a deadline: who opened it, when,
          why, and which section. The employee sees exactly what HR wrote. */}
      {windowOpen && (
        <div className="card section" style={{ borderColor: 'var(--teal)' }}>
          <h3>🔓 Edit access granted</h3>
          <div className="kv"><span className="k">Section opened</span><span>{employee.unlockGrantSection || 'All fields'}</span></div>
          <div className="kv"><span className="k">Reason</span><span>{employee.unlockGrantReason || employee.unlockDecisionNote || '—'}</span></div>
          <div className="kv"><span className="k">Granted by</span>
            <span>{employee.unlockedByName || 'HR'}{employee.unlockedAt ? ` · ${new Date(employee.unlockedAt).toLocaleString('en-GB')}` : ''}</span></div>
          <div className="kv"><span className="k">Access expires</span><span><b>{windowEndsAt.toLocaleString('en-GB')}</b></span></div>
          <div className="small-muted" style={{ marginTop: 6 }}>
            Submitting your changes closes the window; so does the deadline, whichever comes first.
          </div>
        </div>
      )}

      {locked && (
        <div className="card section">
          <h3>Profile locked</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            Your employee profile has been approved and locked. To make further changes, request edit access below.
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
                  <Combo required value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)}>
                    <option value="">Select a reason</option>
                    {config.unlockRequestReasons.map((r) => <option key={r}>{r}</option>)}
                  </Combo>
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
        {!editable && (
          <div className="notice" style={{ marginBottom: 12 }}>
            🔒 {awaitingReview ? 'Submitted — this is the form you sent to HR.' : 'Your submitted form.'} It is read-only;
            {' '}{awaitingReview ? 'HR will approve it or send it back to you.' : 'to change anything, request edit access above.'}
          </div>
        )}
        {/* The photo leads the form; uploading it is a document, so it works
            whenever documents can be added. */}
        <EmployeePhoto employeeId={employee.id} name={employee.name} />
        <EmployeeProfileForm mode="self" form={form} setForm={setForm} employee={employee} readOnly={!editable} />
        {/* The email in the form above, proved by a code sent to it. */}
        <EmailVerify email={form.email} disabled={false} />

        {/* DOCUMENTS — a section OF this form (user, 2026-09-29), not a
            separate one. While the form is open, the files picked here go up
            when Submit is pressed. Once it is locked there is no Submit, so
            each file gets its own Upload button (a document HR asks for can
            still be added). Only a document they uploaded themselves can be
            removed, and only while the form is open (routes/employees.js). */}
        <EmployeeDocuments
          ref={docsRef}
          embedded
          uploadOnSave={editable}
          saveLabel="Submit"
          employeeId={employee.id}
          intro="Aadhaar, PAN, certificates and joining documents — as many as you need. HR sees them on your record."
          lockedNote={editable ? null : 'Your form is locked. You can still add a document HR asks for; only HR can remove documents now.'}
        />

        {message && <div className="small-muted" style={{ marginTop: 8 }}>{message}</div>}
        {editable && (
          <div className="emp-form-foot">
            <button className="btn btn-primary btn-sm" type="submit">Submit</button>
            <span className="small-muted">
              Fields you can&apos;t change are set by HR. Submit uploads your documents and sends the form — it then
              locks and you can only view it.
            </span>
          </div>
        )}
      </form>

      {/* -------------------------------------------------------------------
          IDENTITY VERIFICATION — the employee proving their own mobile and
          Aadhaar.

          Deliberately OUTSIDE the submit-for-review cycle: HR does not approve
          whether somebody owns a phone, and a profile lock must not stop
          somebody verifying a new number.

          It is also deliberately blunt about what it cannot do today. A tick
          that does not mean "UIDAI said yes" must not look like one, so there
          are three states here and not two: Verified, Checked only, and Not
          verified.
          ------------------------------------------------------------------- */}
      {employee.verification && (
        <div className="card section">
          <h3>Identity verification</h3>
          <div className="small-muted" style={{ marginBottom: 12 }}>
            Your Aadhaar number is used for the check and then discarded — only the last four
            digits are kept. It is never stored in full, and never shown to HR.
          </div>

          <div className="grid-2" style={{ marginBottom: 4 }}>
            <div className="kv">
              <span className="k">Mobile</span>
              <span>
                {employee.verification.mobile.verified
                  ? <span className="status approved">Verified · {employee.verification.mobile.number}</span>
                  : <span className="status pending">Not verified</span>}
              </span>
            </div>
            <div className="kv">
              <span className="k">Aadhaar</span>
              <span>
                {employee.verification.aadhaar.verified && (
                  <span className="status approved">Verified · ••••{employee.verification.aadhaar.last4}</span>
                )}
                {!employee.verification.aadhaar.verified && employee.verification.aadhaar.last4 && (
                  <span className="status hold">Checked only · ••••{employee.verification.aadhaar.last4}</span>
                )}
                {!employee.verification.aadhaar.verified && !employee.verification.aadhaar.last4 && (
                  <span className="status pending">Not verified</span>
                )}
              </span>
            </div>
          </div>
          {employee.verification.aadhaar.note && (
            <div className="small-muted" style={{ marginBottom: 12 }}>{employee.verification.aadhaar.note}</div>
          )}

          {/* The channel is stated BEFORE the button, so nobody presses Send
              and then waits for a code that was never going to arrive. */}
          {employee.channels && !employee.channels.sms.deliverable && (
            <div className="notice amber" style={{ marginBottom: 12 }}>
              {employee.channels.sms.reason}
              {' '}
              A code cannot reach your phone until that is connected. Emailing it instead would
              prove your mailbox, not your number, so this screen does not do that.
            </div>
          )}

          {verr && <div className="error-text" style={{ marginBottom: 10 }}>{verr}</div>}

          {(!vr || vr.done) ? (
            <form onSubmit={startVerify}>
              {vr && vr.done && (
                <div className="notice" style={{ marginBottom: 10 }}>
                  {vr.kind === 'MOBILE' ? 'Mobile verified.' : (vr.note || 'Done.')}
                </div>
              )}
              <div className="grid-2">
                <label className="field">
                  <span>What do you want to verify?</span>
                  <select value={vf.kind} onChange={(e) => setVf({ ...vf, kind: e.target.value })}>
                    <option value="MOBILE">Mobile number</option>
                    <option value="AADHAAR">Aadhaar</option>
                  </select>
                </label>
                <label className="field">
                  <span>Mobile number</span>
                  <input
                    inputMode="numeric"
                    maxLength={13}
                    placeholder="10 digits"
                    value={vf.mobile}
                    onChange={(e) => setVf({ ...vf, mobile: e.target.value })}
                  />
                </label>
              </div>
              {vf.kind === 'AADHAAR' && (
                <label className="field">
                  <span>Aadhaar number</span>
                  <input
                    inputMode="numeric"
                    maxLength={14}
                    placeholder="12 digits"
                    value={vf.aadhaar}
                    onChange={(e) => setVf({ ...vf, aadhaar: e.target.value })}
                  />
                </label>
              )}
              <button className="btn btn-primary" type="submit" disabled={vbusy === 'start'}>
                {vbusy === 'start' ? 'Sending…' : 'Send the code'}
              </button>
            </form>
          ) : (
            <form onSubmit={confirmVerify}>
              <div className="small-muted" style={{ marginBottom: 8 }}>
                {vr.delivered
                  ? `A ${vr.ttlMinutes}-minute code was ${vr.delivery}.`
                  : `A ${vr.ttlMinutes}-minute code was generated for ${vr.mobile}, but could not be sent.`}
              </div>
              {vr.note && <div className="notice amber" style={{ marginBottom: 10 }}>{vr.note}</div>}
              {vr.esignNote && <div className="notice amber" style={{ marginBottom: 10 }}>{vr.esignNote}</div>}
              <label className="field">
                <span>Verification code</span>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 digits"
                  value={vf.otp}
                  onChange={(e) => setVf({ ...vf, otp: e.target.value })}
                />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" type="submit" disabled={vf.otp.length < 6 || vbusy === 'confirm'}>
                  {vbusy === 'confirm' ? 'Verifying…' : 'Verify'}
                </button>
                <button className="btn" type="button" onClick={() => { setVr(null); setVerr(''); }}>
                  Start again
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ATS-100 B6.1: every employee can refer people and share a personal link. */}
      <ReferPanel />

      {isTeamLead && (
        <div className="card section">
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 13 }}>{isDeptScoped ? `My Department — ${employee.department || 'Unassigned'}` : 'All Employees (cross-department oversight)'}</h3>
            <Link className="btn btn-sm" to="/employees">Open Employee Management</Link>
          </div>
          {team.length > 0 && <ListFilterBar lf={teamLf} storageKey="my-team" noun="employees" />}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Code</th><th>Designation</th><th>Status</th><th>Profile Status</th></tr></thead>
              <tbody>
                {teamPage.slice.map((e) => (
                  <tr key={e.id} className="row-link">
                    <td><Link to={`/employees/${e.id}`}>{e.name}</Link></td>
                    <td>{e.employeeCode}</td>
                    <td>{e.designation || '—'}</td>
                    <td><span className={`status ${e.employmentStatus === 'Active' ? 'priority-low' : ''}`}>{e.employmentStatus}</span></td>
                    <td><span className={`status ${STATUS_BADGE[e.profileStatus] || ''}`}>{statusLabel(e.profileStatus)}</span></td>
                  </tr>
                ))}
                {teamLf.rows.length === 0 && <tr><td colSpan="5" className="small-muted"><ListEmpty lf={teamLf} noun="employees" title="No department employees yet." /></td></tr>}
              </tbody>
            </table>
          </div>
          {teamLf.rows.length > 0 && <Pager page={teamPage} noun="employees" />}
        </div>
      )}
    </div>
  );
}

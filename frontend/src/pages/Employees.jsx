import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal.jsx';
import { atsRoleLabel } from '../atsVocab';

// Administration -> Employee Management — the prototype's employeeMgmtView()
// (line 9754) and openAddEmployeeModal() (line 2857).
//
// Employee *account* administration, distinct from the HR record: this screen
// owns login access, product roles and scope. One Employee = One User = One
// Login. Eighteen columns, three filters, and per-row View / Assign Roles /
// Activate-Deactivate / Reset Password / Create Login.
//
// ROLE MODEL: main carries one User.role. The prototype's three product roles
// are shown here derived and read-only (backend utils/roleAccess.js
// PRODUCT_ACCESS); the Assign Roles modal edits the single stored role and the
// department scope. That split is deliberately deferred — see schema.prisma.
//
// MAIN-ONLY, KEPT: the employee name links into the full HR record, where the
// profile lock / unlock workflow lives.

const EMPTY_NEW = {
  name: '', dateOfBirth: '', gender: '—',
  email: '', phone: '', location: '',
  department: '', designation: '', reportingManagerId: '', stl: '', tl: '', team: '',
  dateOfJoining: new Date().toISOString().slice(0, 10), employeeType: 'Full Time', employmentStatus: 'Active',
  role: 'EMPLOYEE', atsDepartment: '', password: '',
};

export default function Employees() {
  const [rows, setRows] = useState([]);
  const [hr, setHr] = useState([]); // the HR record side: profile stage, lock, completion
  const [options, setOptions] = useState(null);
  const [employeeIds, setEmployeeIds] = useState([]);
  const [depts, setDepts] = useState([]);
  const [filters, setFilters] = useState({ q: '', dept: '', status: '' });
  const [adding, setAdding] = useState(null);
  const [roleTarget, setRoleTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [resetFor, setResetFor] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  // main-only: bulk CSV import/export and the department transfer trail.
  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [exporting, setExporting] = useState(false);
  // The HR review surface: submitted profiles and unlock requests waiting on
  // a decision, both scoped by the server to what this caller may see.
  const [queue, setQueue] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferForm, setTransferForm] = useState({ department: '', team: '', reason: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function load() {
    api.get('/admin/employee-management').then((res) => {
      setRows(res.data);
      setEmployeeIds(res.data.map((r) => ({ id: r.id, name: r.name })));
    }).catch(() => setError('Employee Management is restricted to Super Admin and Admin.'));
    // main-only: profileStage / isLocked / completion come off the HR record.
    api.get('/employees').then((res) => setHr(res.data)).catch(() => setHr([]));
    api.get('/employees/review-queue').then((res) => setQueue(res.data)).catch(() => setQueue(null));
  }
  useEffect(() => {
    load();
    api.get('/admin/employee-management/options').then((res) => setOptions(res.data)).catch(() => setOptions(null));
    api.get('/admin/departments').then((res) => setDepts(res.data)).catch(() => setDepts([]));
  }, []);

  async function run(fn, message) {
    setError(''); setNotice('');
    try { await fn(); if (message) setNotice(message); load(); return true; } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
      return false;
    }
  }

  const filtered = useMemo(() => rows.filter((e) => {
    const q = filters.q.trim().toLowerCase();
    if (q && !`${e.name} ${e.employeeCode} ${e.email || ''}`.toLowerCase().includes(q)) return false;
    if (filters.dept && e.department !== filters.dept) return false;
    if (filters.status && (e.employmentStatus || 'Active') !== filters.status) return false;
    return true;
  }), [rows, filters]);

  const rowDepts = useMemo(() => [...new Set(rows.map((e) => e.department).filter(Boolean))].sort(), [rows]);
  const hrById = useMemo(() => Object.fromEntries(hr.map((e) => [e.id, e])), [hr]);
  const transferTeams = depts.find((d) => d.name === transferForm.department)?.teams || [];

  // main-only: the profile lock / unlock workflow and the offboarding states
  // this app tracks and the prototype has no counterpart for.
  // RFC 4180 parsing — quoted fields may hold commas, newlines and doubled
  // quotes. Splitting on "," alone silently shifted every later column of a
  // row whose designation read "Engineer, Senior".
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const src = String(text).replace(/^﻿/, '');
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
        } else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
    if (!nonEmpty.length) return { headers: [], rows: [] };
    const headers = nonEmpty[0].map((h) => h.trim().toLowerCase());
    return {
      headers,
      rows: nonEmpty.slice(1).map((cells) => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (cells[i] || '').trim(); });
        return obj;
      }),
    };
  }

  // Nothing is written unless EVERY row passes. `validateOnly` runs the same
  // server-side checks without writing, so HR can dry-run a file first.
  async function runImport(validateOnly) {
    setError(''); setNotice(''); setImportResult(null); setImportErrors([]);
    const parsed = parseCsv(csvText);
    if (!parsed.rows.length) { setError('That file has no data rows.'); return; }
    setImportBusy(true);
    try {
      const res = await api.post('/employees/bulk-import', { rows: parsed.rows, validateOnly: !!validateOnly });
      setImportResult(res.data);
      if (!validateOnly) { setCsvText(''); setImportFileName(''); load(); }
    } catch (err) {
      const data = err.response?.data;
      setImportErrors(data?.errors || []);
      setImportResult(data && data.errors ? data : null);
      if (!data?.errors) setError(data?.error || 'The import could not be run.');
    } finally { setImportBusy(false); }
  }

  function readFile(file) {
    if (!file) return;
    setImportFileName(file.name);
    setImportResult(null); setImportErrors([]);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.readAsText(file);
  }

  // The server builds the CSV and scopes it: a TL downloads their own
  // department, not the company. The browser only saves what comes back.
  async function exportCsv() {
    setError(''); setNotice(''); setExporting(true);
    try {
      const res = await api.get('/employees/export.csv', { responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || 'employees.csv';
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
      setNotice(`Exported ${name} — scoped to what your role may see.`);
    } catch {
      setError('Export is not included in your role’s permissions.');
    } finally { setExporting(false); }
  }

  async function submitTransfer(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/employees/${transferTarget.id}/transfer`, transferForm), `${transferTarget.name} transferred.`);
    if (ok) setTransferTarget(null);
  }

  async function saveNew() {
    setError(''); setNotice(''); setCredentials(null);
    try {
      const res = await api.post('/admin/employee-management', adding);
      setNotice(`${adding.name} created — employee record and login together.`);
      // What actually happened to the sign-in email, verbatim from the server.
      // When there is no SMTP provider this says so and hands over the link;
      // it never implies the employee has been told.
      setCredentials(res.data.credentials ? { ...res.data.credentials, name: adding.name } : null);
      setAdding(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    }
  }

  async function saveRoles() {
    const ok = await run(
      () => api.put(`/admin/employee-management/${roleTarget.id}/roles`, {
        role: roleTarget.role, atsDepartment: roleTarget.atsDepartment, stl: roleTarget.stl, tl: roleTarget.tl,
      }),
      `${roleTarget.name} — roles updated on the same login (${roleTarget.userId}).`,
    );
    if (ok) setRoleTarget(null);
  }

  async function openDetail(id) {
    setError('');
    try { setDetail((await api.get(`/admin/employee-management/${id}`)).data); } catch { setError('Could not open that employee.'); }
  }

  async function submitReset(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/admin/employee-management/${resetFor.id}/reset-password`, { password: resetPassword }),
      `Password reset for ${resetFor.name}. Share it out of band — it is never shown again.`);
    if (ok) { setResetFor(null); setResetPassword(''); }
  }

  const productAccess = (row, product) => (row.productAccess ? row.productAccess[product] : '—');

  return (
    <div>
      <div className="breadcrumb">Administration / Employee Management</div>
      <div className="page-head">
        <div><h1>Employee Management</h1>
          <div className="page-sub">
            Employee master administration, login access and product roles. The HR record itself lives in HRMS → Employees.
          </div></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* main-only: CSV bulk import / export */}
          <button className="btn" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
          <button className="btn" onClick={() => setShowImport((s) => !s)}>Bulk Import</button>
          <button className="btn btn-primary" onClick={() => setAdding({ ...EMPTY_NEW })}>Add Employee</button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      {credentials && (
        <div className="card section" style={{ borderColor: credentials.sent ? undefined : 'var(--warn)' }}>
          <h3 style={{ fontSize: 13 }}>Sign-in details for {credentials.name}</h3>
          <div className={credentials.sent ? 'notice' : 'error-text'}>{credentials.status}</div>
          {!credentials.sent && credentials.link && (
            <div className="small-muted" style={{ marginTop: 8, wordBreak: 'break-all' }}>
              <b>Nothing was emailed.</b> Connect an SMTP provider in Administration → Integrations, or pass this
              single-use link on yourself. It is shown once and expires{' '}
              {credentials.expiresAt ? new Date(credentials.expiresAt).toLocaleString('en-GB') : 'shortly'}:
              <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}>{credentials.link}</div>
            </div>
          )}
          <div className="small-muted" style={{ marginTop: 8 }}>
            No password is ever emailed — the employee chooses their own through the link.
          </div>
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setCredentials(null)}>Dismiss</button>
        </div>
      )}

      {/* HR's review surface. Everything waiting on a decision, in one place;
          the server scopes both queues to what this caller may see. */}
      {queue && (queue.submitted.length > 0 || queue.unlockRequests.length > 0) && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }}>
          <h3>Waiting for your review — {queue.scope}</h3>
          {queue.submitted.length > 0 && (
            <>
              <div className="section-label">Profiles submitted for review ({queue.submitted.length})</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Employee</th><th>Department</th><th>Fields changed</th><th>Submitted</th><th></th></tr></thead>
                  <tbody>
                    {queue.submitted.map((e) => (
                      <tr key={e.id}>
                        <td className="row-link"><Link to={`/employees/${e.id}`}>{e.name}</Link> <span className="cell-muted">{e.employeeCode}</span></td>
                        <td className="cell-muted">{e.department || '—'}</td>
                        <td className="cell-muted">
                          {(e.pendingChanges || []).slice(0, 4).map((c) => c.label || c.field).join(', ')}
                          {(e.pendingChanges || []).length > 4 ? ` +${e.pendingChanges.length - 4} more` : ''}
                        </td>
                        <td className="cell-muted">{new Date(e.updatedAt).toLocaleString('en-GB')}</td>
                        <td><Link className="btn btn-sm btn-primary" to={`/employees/${e.id}`}>Review</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {queue.unlockRequests.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 12 }}>Edit-access requests ({queue.unlockRequests.length})</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Employee</th><th>Department</th><th>Reason</th><th>Request</th><th></th></tr></thead>
                  <tbody>
                    {queue.unlockRequests.map((e) => (
                      <tr key={e.id}>
                        <td className="row-link"><Link to={`/employees/${e.id}`}>{e.name}</Link> <span className="cell-muted">{e.employeeCode}</span></td>
                        <td className="cell-muted">{e.department || '—'}</td>
                        <td className="cell-muted">{e.unlockRequestReason || '—'}</td>
                        <td className="cell-muted">{e.unlockRequestCount} of {queue.unlockRequestLimit}</td>
                        <td><Link className="btn btn-sm btn-primary" to={`/employees/${e.id}`}>Decide</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!queue.canDecide && (
            <div className="small-muted" style={{ marginTop: 8 }}>
              You can see this queue but approving is not included in your role&apos;s permissions.
            </div>
          )}
        </div>
      )}

      {showImport && (
        <div className="card section">
          <h3>Bulk import (CSV)</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Header row required. Recognized columns: name, email, phone, department, designation, location.
            <b> Nothing is written unless every row passes</b> — a file with one bad row is refused whole, with the
            line number of each problem. Import never creates logins: send sign-in details per employee afterwards.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="file" accept=".csv,text/csv" onChange={(e) => readFile(e.target.files?.[0])} />
            {importFileName && <span className="cell-muted" style={{ fontSize: 12 }}>{importFileName}</span>}
          </div>
          <textarea
            rows="5" style={{ width: '100%', padding: 8, borderRadius: 7, border: '1px solid var(--line)', fontFamily: 'monospace', fontSize: 12.5 }}
            placeholder={'name,email,phone,department,designation,location\nAsha Rao,asha.rao@example.com,9876543210,IT,Software Engineer,Hyderabad'}
            value={csvText} onChange={(e) => { setCsvText(e.target.value); setImportResult(null); setImportErrors([]); }}
          />
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-sm" disabled={importBusy} onClick={() => runImport(true)}>Check file</button>{' '}
            <button className="btn btn-primary btn-sm" disabled={importBusy} onClick={() => runImport(false)}>Import</button>
          </div>
          {importErrors.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="error-text">
                Nothing was imported. {importErrors.length} problem(s) — fix the file and try again.
              </div>
              <div className="tbl-wrap" style={{ marginTop: 6 }}>
                <table>
                  <thead><tr><th style={{ width: 90 }}>Line</th><th>Row</th><th>Problem</th></tr></thead>
                  <tbody>
                    {importErrors.map((e, i) => (
                      <tr key={i}><td><b>{e.line || '—'}</b></td><td className="cell-muted">{e.name || '—'}</td><td>{e.message}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {importResult && importResult.ok && (
            <div className="notice" style={{ marginTop: 8 }}>{importResult.message}</div>
          )}
        </div>
      )}

      {transferTarget && (
        <form className="card section" onSubmit={submitTransfer} style={{ borderColor: 'var(--warn)' }}>
          <h3>Transfer {transferTarget.name}</h3>
          <div className="grid-2">
            <label className="field"><span>Department</span>
              <select required value={transferForm.department} onChange={(e) => setTransferForm({ ...transferForm, department: e.target.value, team: '' })}>
                <option value="">Select department</option>
                {depts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select></label>
            {transferTeams.length > 0 && (
              <label className="field"><span>Team</span>
                <select value={transferForm.team} onChange={(e) => setTransferForm({ ...transferForm, team: e.target.value })}>
                  <option value="">No team</option>
                  {transferTeams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select></label>
            )}
            <label className="field"><span>Reason (optional)</span>
              <input value={transferForm.reason} onChange={(e) => setTransferForm({ ...transferForm, reason: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Confirm Transfer</button>{' '}
          <button className="btn btn-sm" type="button" onClick={() => setTransferTarget(null)}>Cancel</button>
        </form>
      )}

      <div className="filter-row">
        <input
          type="text" placeholder="Search name, ID or email…"
          value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <select value={filters.dept} onChange={(e) => setFilters((f) => ({ ...f, dept: e.target.value }))}>
          <option value="">All departments</option>
          {rowDepts.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>
          {(options?.statusFilter || ['Active', 'Notice Period', 'Relieved', 'Inactive']).map((s) => <option key={s}>{s}</option>)}
        </select>
        <span className="cell-muted" style={{ alignSelf: 'center', fontSize: 12 }}>{filtered.length} employee(s)</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee ID</th><th>Name</th><th>Email</th><th>Mobile</th><th>Department</th><th>Designation</th>
              <th>Reporting Manager</th><th>STL</th><th>TL</th><th>Location</th><th>Joining Date</th><th>Employment Status</th>
              <th>HRMS Role</th><th>ATS Role</th><th>Accounts Role</th><th>Login Status</th><th>Last Login</th>
              {/* main-only, appended after the prototype's eighteen: the profile
                  lock / unlock workflow's state and how far the profile is filled. */}
              <th>Profile Stage</th><th>Completion</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td><b>{e.employeeCode}</b></td>
                <td className="row-link"><Link to={`/employees/${e.id}`}>{e.name}</Link></td>
                <td className="cell-muted">{e.email || '—'}</td>
                <td className="cell-muted">{e.phone || '—'}</td>
                <td className="cell-muted">{e.department || '—'}</td>
                <td className="cell-muted">{e.designation || '—'}</td>
                <td className="cell-muted">{e.reportingManager || '—'}</td>
                <td className="cell-muted">{e.stl || '—'}</td>
                <td className="cell-muted">{e.tl || '—'}</td>
                <td className="cell-muted">{e.location || '—'}</td>
                <td className="cell-muted">{e.joiningDate || '—'}</td>
                <td><span className={`status ${(e.employmentStatus || 'Active') === 'Active' ? 'active' : 'pending'}`}>{e.employmentStatus || 'Active'}</span></td>
                <td className="cell-muted">{productAccess(e, 'hrms')}</td>
                <td className="cell-muted">{productAccess(e, 'ats')}</td>
                <td className="cell-muted">{productAccess(e, 'accounts')}</td>
                <td><span className={`status ${e.loginStatus === 'Active' ? 'active' : 'rejected'}`}>{e.loginStatus}</span></td>
                <td className="cell-muted">{e.lastLogin || '—'}</td>
                <td>
                  <span className={`status ${hrById[e.id]?.profileStage === 'Locked' ? 'active' : hrById[e.id]?.profileStage === 'Pending Review' ? 'pending' : ''}`}>
                    {hrById[e.id]?.profileStage === 'Locked' ? '🔒 Locked' : (hrById[e.id]?.profileStage || '—')}
                  </span>
                </td>
                <td className="cell-muted">{hrById[e.id] ? `${hrById[e.id].profileCompletionPct}%` : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => openDetail(e.id)}>View</button>{' '}
                  <button className="btn btn-sm" onClick={() => (e.userId
                    ? setRoleTarget({ ...e, role: e.role, atsDepartment: e.atsDepartment || '', stl: e.stl || '', tl: e.tl || '' })
                    : setError('Create a login for this employee first.'))}>Assign Roles</button>{' '}
                  {e.userId ? (
                    <>
                      <button className="btn btn-sm" onClick={() => run(() => api.post(`/admin/employee-management/${e.id}/toggle-login`), `${e.name} login ${e.loginStatus === 'Active' ? 'deactivated' : 'activated'}.`)}>
                        {e.loginStatus === 'Active' ? 'Deactivate' : 'Activate'}
                      </button>{' '}
                      <button className="btn btn-sm btn-ghost" onClick={() => { setResetFor(e); setResetPassword(''); }}>Reset Password</button>{' '}
                      {/* Re-issues the single-use sign-in link and emails it
                          from the acting HR user's own address. */}
                      <button className="btn btn-sm" onClick={async () => {
                        setError(''); setNotice(''); setCredentials(null);
                        try {
                          const res = await api.post(`/employees/${e.id}/send-credentials`);
                          setCredentials({ ...res.data.credentials, name: e.name });
                          load();
                        } catch (err) { setError(err.response?.data?.error || 'Could not issue sign-in details.'); }
                      }}>Send Sign-in</button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={() => run(() => api.post(`/admin/employee-management/${e.id}/create-login`), `Login created for ${e.name}.`)}>Create Login</button>
                  )}
                  {/* main-only: transfer with an audit trail, the profile
                      lock / unlock workflow, probation pause and hard delete. */}
                  {' '}<button className="btn btn-sm" onClick={() => { setTransferTarget(e); setTransferForm({ department: e.department || '', team: '', reason: '' }); }}>Transfer</button>{' '}
                  <button className="btn btn-sm" onClick={() => run(() => api.patch(`/employees/${e.id}/toggle-lock`), `${e.name} profile ${hrById[e.id]?.isLocked ? 'unlocked' : 'locked'}.`)}>
                    {hrById[e.id]?.isLocked ? 'Unlock' : 'Lock'}
                  </button>{' '}
                  <button className="btn btn-sm" onClick={() => run(() => api.patch(`/employees/${e.id}/toggle-pause`), `${e.name} updated.`)}>
                    {e.employmentStatus === 'On Probation' ? 'Resume' : 'Pause'}
                  </button>{' '}
                  <button className="btn btn-sm btn-ghost" onClick={() => {
                    if (!confirm(`Permanently delete ${e.name}? This removes their attendance, leave, payslip and other records too. This can't be undone.`)) return;
                    run(() => api.delete(`/employees/${e.id}`), `${e.name} deleted.`);
                  }}>Delete</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan="20" className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        One Employee = One User = One Login. Assigning a role here changes product access on the employee&apos;s
        existing login — it never creates a second account.
      </div>

      {resetFor && (
        <Modal
          title={`Reset Password — ${resetFor.name}`}
          onClose={() => setResetFor(null)}
          foot={<>
            <button className="btn" onClick={() => setResetFor(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={submitReset}>Reset Password</button>
          </>}
        >
          <form onSubmit={submitReset}>
            <div className="field"><label>New password *</label>
              <input required type="password" minLength="6" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} /></div>
            <div className="cell-muted" style={{ fontSize: 11.5 }}>
              The password is stored hashed and never shown again — pass it to the user yourself.
            </div>
          </form>
        </Modal>
      )}

      {adding && options && (
        <AddEmployeeModal
          form={adding} setForm={setAdding} options={options} employees={employeeIds}
          onClose={() => setAdding(null)} onSave={saveNew}
        />
      )}

      {roleTarget && options && (
        <Modal
          title={`Assign Roles — ${roleTarget.name}`}
          onClose={() => setRoleTarget(null)}
          foot={<>
            <button className="btn" onClick={() => setRoleTarget(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveRoles}>Save Roles</button>
          </>}
        >
          <div className="kv"><span className="k">Employee / Login</span><span>{roleTarget.employeeCode} · {roleTarget.userId}</span></div>
          <div className="notice">
            HRMS, ATS and Accounts access all sit on the <b>same login</b>. They are derived from the one stored
            role below — the three-role split is a separate, deferred change, so they are shown here read-only.
          </div>
          <div className="field"><label>Role</label>
            <select value={roleTarget.role || 'EMPLOYEE'} onChange={(e) => setRoleTarget({ ...roleTarget, role: e.target.value, productAccess: options.productAccess[e.target.value] })}>
              {options.roles.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
            </select></div>
          <div className="grid-3">
            <div className="field"><label>HRMS Role</label>
              <input value={(options.productAccess[roleTarget.role] || {}).hrms || '—'} disabled /></div>
            <div className="field"><label>ATS Role</label>
              <input value={(options.productAccess[roleTarget.role] || {}).ats || '—'} disabled /></div>
            <div className="field"><label>Accounts Role</label>
              <input value={(options.productAccess[roleTarget.role] || {}).accounts || '—'} disabled /></div>
          </div>
          <div className="field"><label>Scope (department / team)</label>
            <select value={roleTarget.atsDepartment || ''} onChange={(e) => setRoleTarget({ ...roleTarget, atsDepartment: e.target.value })}>
              <option value="">Organization</option>
              {options.departments.map((d) => <option key={d}>{d}</option>)}
            </select></div>
          <div className="grid-2">
            <div className="field"><label>STL</label>
              <select value={roleTarget.stl || ''} onChange={(e) => setRoleTarget({ ...roleTarget, stl: e.target.value })}>
                <option value="">—</option>
                {options.managerNames.map((n) => <option key={n}>{n}</option>)}
              </select></div>
            <div className="field"><label>TL</label>
              <select value={roleTarget.tl || ''} onChange={(e) => setRoleTarget({ ...roleTarget, tl: e.target.value })}>
                <option value="">—</option>
                {options.managerNames.map((n) => <option key={n}>{n}</option>)}
              </select></div>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal
          title={`${detail.name} — ${detail.employeeCode}`}
          size="wide"
          onClose={() => setDetail(null)}
          foot={<>
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
            <Link className="btn btn-primary" to={`/employees/${detail.id}`} onClick={() => setDetail(null)}>Open HR record</Link>
          </>}
        >
          <div className="kv"><span className="k">Email</span><span>{detail.email || '—'}</span></div>
          <div className="kv"><span className="k">Mobile</span><span>{detail.phone || '—'}</span></div>
          <div className="kv"><span className="k">Department</span><span>{detail.department || '—'}</span></div>
          <div className="kv"><span className="k">Designation</span><span>{detail.designation || '—'}</span></div>
          <div className="kv"><span className="k">Reporting Manager</span><span>{detail.reportingManager || '—'}</span></div>
          <div className="kv"><span className="k">Location</span><span>{detail.location || '—'}</span></div>
          <div className="kv"><span className="k">Joining Date</span><span>{detail.joiningDate || '—'}</span></div>
          <div className="kv"><span className="k">Employment Status</span><span>{detail.employmentStatus}</span></div>
          <div className="section-label">Login &amp; product access</div>
          {detail.userId ? (
            <>
              <div className="kv"><span className="k">User ID</span><span>{detail.userId}</span></div>
              <div className="kv"><span className="k">HRMS / ATS / Accounts</span>
                <span>{detail.productAccess.hrms} · {detail.productAccess.ats} · {detail.productAccess.accounts}</span></div>
              <div className="kv"><span className="k">Scope</span><span>{detail.scope}</span></div>
              <div className="kv"><span className="k">Login status</span><span>{detail.loginStatus}</span></div>
            </>
          ) : <div className="empty-mini">No login created yet.</div>}
          <div className="section-label">Recent activity</div>
          {detail.activity.length ? detail.activity.map((a, i) => (
            <div className="assign-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={i}>
              <span style={{ fontSize: 12 }}>{a.action}</span>
              <span className="cell-muted" style={{ fontSize: 11.5 }}>{a.date}</span>
            </div>
          )) : <div className="empty-mini">No recorded activity for this employee yet.</div>}
        </Modal>
      )}
    </div>
  );
}

// Add Employee — the prototype's openAddEmployeeModal(): the employee record
// and the login are created together, one employee, one user, one login.
// Sections and field order are the prototype's.
function AddEmployeeModal({ form, setForm, options, employees, onClose, onSave }) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const access = options.productAccess[form.role] || {};
  const scope = form.atsDepartment || `${form.department || '—'} (own department)`;

  return (
    <Modal
      title="Add Employee"
      note={`${options.nextEmployeeCode || ''} · a login is created with this record`}
      size="wide"
      onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={onSave}>Create Employee &amp; Login</button>
      </>}
    >
      <div className="section-label">Personal</div>
      <div className="grid-3">
        <div className="field"><label>Full name *</label>
          <input type="text" placeholder="As it should appear on records" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="field"><label>Date of birth</label>
          <input type="date" value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} /></div>
        <div className="field"><label>Gender</label>
          <select value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
            {options.genders.map((g) => <option key={g}>{g}</option>)}
          </select></div>
      </div>

      <div className="section-label">Contact</div>
      <div className="grid-3">
        <div className="field"><label>Official email</label>
          <input type="email" placeholder="name@tmlink.in" value={form.email} onChange={(e) => set({ email: e.target.value })} /></div>
        <div className="field"><label>Mobile</label>
          <input type="text" placeholder="10 digits" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></div>
        <div className="field"><label>Location</label>
          <select value={form.location} onChange={(e) => set({ location: e.target.value })}>
            <option value="">—</option>
            {options.locations.map((l) => <option key={l}>{l}</option>)}
          </select></div>
      </div>

      <div className="section-label">Position</div>
      <div className="grid-3">
        <div className="field"><label>Department</label>
          <select value={form.department} onChange={(e) => set({ department: e.target.value })}>
            <option value="">—</option>
            {options.departments.map((d) => <option key={d}>{d}</option>)}
          </select></div>
        <div className="field"><label>Designation</label>
          <input type="text" placeholder="e.g. Senior Recruiter" value={form.designation} onChange={(e) => set({ designation: e.target.value })} /></div>
        <div className="field"><label>Reporting manager</label>
          <select value={form.reportingManagerId} onChange={(e) => set({ reportingManagerId: e.target.value })}>
            <option value="">—</option>
            {employees.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></div>
        <div className="field"><label>STL</label>
          <select value={form.stl} onChange={(e) => set({ stl: e.target.value })}>
            <option value="">—</option>
            {options.managerNames.map((n) => <option key={n}>{n}</option>)}
          </select></div>
        <div className="field"><label>TL</label>
          <select value={form.tl} onChange={(e) => set({ tl: e.target.value })}>
            <option value="">—</option>
            {options.managerNames.map((n) => <option key={n}>{n}</option>)}
          </select></div>
        <div className="field"><label>Team</label>
          <input type="text" placeholder="e.g. Section A" value={form.team} onChange={(e) => set({ team: e.target.value })} /></div>
      </div>

      <div className="section-label">Employment</div>
      <div className="grid-3">
        <div className="field"><label>Date of joining</label>
          <input type="date" value={form.dateOfJoining} onChange={(e) => set({ dateOfJoining: e.target.value })} /></div>
        <div className="field"><label>Employment type</label>
          <select value={form.employeeType} onChange={(e) => set({ employeeType: e.target.value })}>
            {options.empTypes.map((t) => <option key={t}>{t}</option>)}
          </select></div>
        <div className="field"><label>Status</label>
          <select value={form.employmentStatus} onChange={(e) => set({ employmentStatus: e.target.value })}>
            {options.empStatuses.map((s) => <option key={s}>{s}</option>)}
          </select></div>
      </div>

      <div className="section-label">Product access — one login, three products</div>
      <div className="grid-3">
        <div className="field"><label>Role</label>
          <select value={form.role} onChange={(e) => set({ role: e.target.value })}>
            {options.roles.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
          </select></div>
        <div className="field"><label>HRMS role</label><input value={access.hrms || 'No Access'} disabled /></div>
        <div className="field"><label>ATS role</label><input value={access.ats || 'No Access'} disabled /></div>
        <div className="field"><label>Accounts role</label><input value={access.accounts || 'No Access'} disabled /></div>
        <div className="field"><label>ATS department scope</label>
          <select value={form.atsDepartment} onChange={(e) => set({ atsDepartment: e.target.value })}>
            <option value="">Own department</option>
            <option>All departments</option>
            {options.departments.map((d) => <option key={d}>{d}</option>)}
          </select></div>
        {/* Optional and discouraged. Leave it empty and the employee gets a
            single-use link to choose their own password — no password is ever
            emailed, and the account has no guessable default in the meantime. */}
        <div className="field"><label>Temporary password (leave empty — recommended)</label>
          <input type="password" placeholder="leave empty to email a set-password link" value={form.password} onChange={(e) => set({ password: e.target.value })} /></div>
      </div>

      {/* The prototype's neSummary(): what this person will actually be able to
          do, shown before saving. */}
      <div className="notice" style={{ marginTop: 10 }}>
        <span>
          HRMS → {access.hrms || 'No Access'}&nbsp;&nbsp;·&nbsp;&nbsp;ATS → {access.ats || 'No Access'}&nbsp;&nbsp;·&nbsp;&nbsp;
          Accounts → {access.accounts || 'No Access'}&nbsp;&nbsp;·&nbsp;&nbsp;ATS scope: {scope}.
          One login covers all three — no second account is created.
        </span>
      </div>
    </Modal>
  );
}

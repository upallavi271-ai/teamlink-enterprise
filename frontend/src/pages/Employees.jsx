import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal.jsx';
import { atsRoleLabel } from '../atsVocab';
import { STATUS_BADGE, statusLabel } from '../components/ProfileStatusBanner.jsx';
import Combo from '../components/Combo.jsx';

// HRMS -> Employee Management — the prototype's employeeMgmtView() (line 9754)
// and openAddEmployeeModal() (line 2857).
//
// THE ONE PLACE employee administration happens. Add Employee, Bulk Import,
// Export, the filters and Edit Scope all live here; Administration -> Users
// links to this screen for the first and the last of those rather than
// carrying a second copy of either. One Employee = One User = One Login.
//
// Everything is scoped by the SERVER (/api/employees/management, guarded by
// `hrms / Employee Management / <action>`), so a TL opening this screen gets
// their own department's employees — not an empty table and not the company.
// The `caps` the list returns say what this caller may actually do, and the
// API still refuses anything the screen mistakenly offers.

const EMPTY_NEW = {
  employeeId: '', name: '', dateOfBirth: '', gender: '—',
  email: '', phone: '', location: '',
  department: '', designation: '', reportingManagerId: '', stl: '', tl: '', team: '',
  dateOfJoining: new Date().toISOString().slice(0, 10), employeeType: 'Full Time', employmentStatus: 'Active',
  password: '',
};

// The email one-time code that gates Add Employee. `configured: false` is an
// honest state, not an error: no channel, no code, and the form says so.
const EMPTY_OTP = { sending: false, sent: false, code: '', verified: false, message: '', error: '' };

function csvList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// One checkbox list, used three times by the scope editor. MOVED here with
// Edit Scope from Administration -> Users; there is no second copy of it.
function ScopeChecklist({ label, hint, options, value, onChange, empty }) {
  const selected = csvList(value);
  function toggle(name, on) {
    const next = on ? [...selected, name] : selected.filter((s) => s !== name);
    onChange([...new Set(next)].join(','));
  }
  return (
    <div className="field">
      <label>{label}</label>
      <div className="small-muted" style={{ marginBottom: 6 }}>{hint}</div>
      {options.length === 0
        ? <div className="empty-mini">{empty}</div>
        : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {options.map((o) => (
              <label key={o.value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={selected.includes(o.value)}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                />
                {o.label}
              </label>
            ))}
          </div>
        )}
    </div>
  );
}

export default function Employees() {
  const [rows, setRows] = useState([]);
  const [caps, setCaps] = useState({});
  const [scopeText, setScopeText] = useState('');
  const [hr, setHr] = useState([]); // the HR record side: profile stage, lock, completion
  const [options, setOptions] = useState(null);
  const [employeeIds, setEmployeeIds] = useState([]);
  const [filters, setFilters] = useState({
    q: '', dept: '', designation: '', role: '', status: '', login: '',
  });
  const [adding, setAdding] = useState(null);
  const [otp, setOtp] = useState(EMPTY_OTP);
  const [roleTarget, setRoleTarget] = useState(null);
  // EDIT SCOPE — which records a login may reach. MOVED here from
  // Administration -> Users; this is the only implementation.
  const [scopeFor, setScopeFor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [resetFor, setResetFor] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  // Validate -> PREVIEW -> Confirm -> Import. `importPreview` holds the
  // server's split of the file; nothing is written while it is on screen.
  const [importPreview, setImportPreview] = useState(null);
  const [importCreateLogins, setImportCreateLogins] = useState(false);
  const [exporting, setExporting] = useState('');
  // GRANT EDIT ACCESS — temporarily reopening one employee's OWN profile.
  // Deliberately NOT the same thing as Edit scope, which changes which
  // records a login may reach and now sits on the Scope column below.
  const [grantFor, setGrantFor] = useState(null);
  const [grantForm, setGrantForm] = useState({ hours: 48, section: 'All fields', reason: '' });
  const [meConfig, setMeConfig] = useState(null);
  // The HR review surface: submitted profiles and unlock requests waiting on
  // a decision, both scoped by the server to what this caller may see.
  const [queue, setQueue] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferForm, setTransferForm] = useState({ department: '', team: '', reason: '' });
  // The inline Reject dialog. Rejecting needs a REASON — the API refuses
  // without one, because the employee has to be told what to correct.
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function load() {
    api.get('/employees/management').then((res) => {
      setRows(res.data.rows || []);
      setCaps(res.data.caps || {});
      setScopeText(res.data.scope || '');
      setEmployeeIds((res.data.rows || []).map((r) => ({ id: r.id, name: r.name })));
    }).catch((err) => setError(err.response?.data?.error || 'Employee Management is not included in your role’s permissions.'));
    // profileStage / isLocked / completion come off the HR record.
    api.get('/employees').then((res) => setHr(res.data)).catch(() => setHr([]));
    api.get('/employees/review-queue').then((res) => setQueue(res.data)).catch(() => setQueue(null));
  }
  function loadOptions() {
    api.get('/employees/management/options').then((res) => setOptions(res.data)).catch(() => setOptions(null));
  }
  useEffect(() => {
    load();
    loadOptions();
    api.get('/employees/me/config').then((res) => setMeConfig(res.data)).catch(() => setMeConfig(null));
  }, []);

  async function run(fn, message) {
    setError(''); setNotice('');
    try { await fn(); if (message) setNotice(message); load(); return true; } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
      return false;
    }
  }

  // APPROVE / REJECT, inline on the row. Same two endpoints the record page
  // uses — this is a second way in, not a second implementation.
  async function approveProfile(e) {
    await run(() => api.patch(`/employees/${e.id}/changes/approve`),
      `${e.name}'s profile approved. It is locked again, and Unlock is on the row if they need to correct something.`);
  }

  async function submitReject(ev) {
    ev.preventDefault();
    const ok = await run(() => api.patch(`/employees/${rejectFor.id}/changes/reject`, { reason: rejectReason.trim() }),
      `Sent back to ${rejectFor.name} with your note.`);
    if (ok) { setRejectFor(null); setRejectReason(''); }
  }

  const filtered = useMemo(() => rows.filter((e) => {
    const q = filters.q.trim().toLowerCase();
    if (q && !`${e.name} ${e.employeeCode} ${e.email || ''}`.toLowerCase().includes(q)) return false;
    if (filters.dept && e.department !== filters.dept) return false;
    if (filters.designation && e.designation !== filters.designation) return false;
    if (filters.role && (e.role || '') !== filters.role) return false;
    if (filters.status && (e.employmentStatus || 'Active') !== filters.status) return false;
    if (filters.login && e.loginStatus !== filters.login) return false;
    return true;
  }), [rows, filters]);

  const rowDepts = useMemo(() => [...new Set(rows.map((e) => e.department).filter(Boolean))].sort(), [rows]);
  const rowDesignations = useMemo(() => [...new Set(rows.map((e) => e.designation).filter(Boolean))].sort(), [rows]);
  const rowRoles = useMemo(() => [...new Set(rows.map((e) => e.role).filter(Boolean))].sort(), [rows]);
  const hrById = useMemo(() => Object.fromEntries(hr.map((e) => [e.id, e])), [hr]);
  const deptTree = options?.departmentTree || [];
  const transferTeams = deptTree.find((d) => d.name === transferForm.department)?.teams || [];
  const filtersOn = Object.values(filters).some(Boolean);

  // RFC 4180 parsing — quoted fields may hold commas, newlines and doubled
  // quotes. Splitting on "," alone silently shifted every later column of a
  // row whose designation read "Engineer, Senior".
  function parseCsv(text) {
    const out = [];
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
      else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    const nonEmpty = out.filter((r) => r.some((c) => String(c).trim() !== ''));
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

  // STEP 2 — PREVIEW. The server validates and returns the split (valid rows
  // and, for each invalid one, Row · Field · Error · expected value). It
  // writes nothing, so HR sees exactly what will land before agreeing to it.
  async function previewImport() {
    setError(''); setNotice(''); setImportResult(null); setImportErrors([]); setImportPreview(null);
    const parsed = parseCsv(csvText);
    if (!parsed.rows.length) { setError('That file has no data rows.'); return; }
    setImportBusy(true);
    try {
      const res = await api.post('/employees/bulk-import/preview', {
        rows: parsed.rows, createLogins: importCreateLogins,
      });
      setImportPreview(res.data);
      setImportErrors(res.data.invalid || []);
    } catch (err) {
      const data = err.response?.data;
      setImportErrors(data?.invalid || data?.errors || []);
      if (!data?.errors && !data?.invalid) setError(data?.error || 'The file could not be checked.');
    } finally { setImportBusy(false); }
  }

  // STEP 3 — CONFIRM. Still all-or-nothing on the server: one bad row and the
  // whole file is refused, so the preview and the result cannot disagree.
  async function confirmImport() {
    setError(''); setNotice(''); setImportResult(null);
    const parsed = parseCsv(csvText);
    if (!parsed.rows.length) { setError('That file has no data rows.'); return; }
    setImportBusy(true);
    try {
      const res = await api.post('/employees/bulk-import', {
        rows: parsed.rows, createLogins: importCreateLogins,
      });
      setImportResult(res.data);
      setImportPreview(null);
      setImportErrors([]);
      setCsvText(''); setImportFileName('');
      load();
    } catch (err) {
      const data = err.response?.data;
      setImportErrors(data?.invalid || data?.errors || []);
      setImportPreview(data && (data.invalid || data.errors) ? data : null);
      if (!data?.errors && !data?.invalid) setError(data?.error || 'The import could not be run.');
    } finally { setImportBusy(false); }
  }

  function readFile(file) {
    if (!file) return;
    setImportFileName(file.name);
    setImportResult(null); setImportErrors([]); setImportPreview(null);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.readAsText(file);
  }

  // The server builds the file and scopes it: a TL downloads their own
  // department, not the company. The browser only saves what comes back, so
  // CSV, Excel and PDF all carry the same rows and the same permission.
  async function exportAs(format) {
    setError(''); setNotice(''); setExporting(format);
    try {
      const res = await api.get(`/employees/export.${format}`, { responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || `employees.${format}`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
      setNotice(`Exported ${name} — scoped to what your role may see.`);
    } catch {
      setError('Export is not included in your role’s permissions.');
    } finally { setExporting(''); }
  }

  // Grant edit access from the row action. One employee, one window, one
  // reason, all recorded.
  async function submitGrant(e) {
    e.preventDefault();
    const ok = await run(
      () => api.post(`/employees/${grantFor.id}/grant-edit-access`, {
        hours: Number(grantForm.hours), section: grantForm.section, reason: grantForm.reason,
      }),
      `Edit access granted to ${grantFor.name} for ${grantForm.hours}h (${grantForm.section}).`,
    );
    if (ok) { setGrantFor(null); setGrantForm({ hours: 48, section: 'All fields', reason: '' }); }
  }

  async function submitTransfer(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/employees/${transferTarget.id}/transfer`, transferForm), `${transferTarget.name} transferred.`);
    if (ok) setTransferTarget(null);
  }

  // --- Add Employee ---------------------------------------------------------
  // A code goes to the address BEFORE the account exists. Where no SMTP
  // channel is configured the button says so and nothing is sent — the form
  // never pretends otherwise.
  const emailReady = !!options?.email?.configured;

  function openAdd() {
    setOtp(EMPTY_OTP);
    setCredentials(null);
    setAdding({ ...EMPTY_NEW, department: options?.departments?.length === 1 ? options.departments[0] : '' });
  }

  async function sendOtp() {
    setOtp({ ...EMPTY_OTP, sending: true });
    try {
      const res = await api.post('/employees/management/email-otp/send', { email: adding.email });
      if (!res.data.configured) { setOtp({ ...EMPTY_OTP, message: res.data.message }); return; }
      setOtp({
        ...EMPTY_OTP, sent: true,
        message: `A 6-digit code was emailed to ${adding.email}. It expires in ${res.data.ttlMinutes} minutes.`,
      });
    } catch (err) {
      setOtp({ ...EMPTY_OTP, error: err.response?.data?.error || 'That code could not be sent.' });
    }
  }

  async function verifyOtp() {
    try {
      await api.post('/employees/management/email-otp/verify', { email: adding.email, code: otp.code });
      setOtp((o) => ({ ...o, verified: true, error: '', message: 'Email verified.' }));
    } catch (err) {
      setOtp((o) => ({ ...o, error: err.response?.data?.error || 'That code could not be checked.' }));
    }
  }

  async function saveNew() {
    setError(''); setNotice(''); setCredentials(null);
    try {
      const res = await api.post('/employees/management', adding);
      setNotice(`${res.data.name} (${res.data.employeeCode}) created — employee record and login together.`
        + ` Role ${atsRoleLabel(res.data.login.role)}${res.data.login.atsRole ? ` · ATS ${atsRoleLabel(res.data.login.atsRole)}` : ''}`
        + ` · scope ${res.data.login.scope}. Email ${res.data.emailChannel}.`);
      // What actually happened to the sign-in email, verbatim from the server.
      // When there is no SMTP provider this says so and hands over the link;
      // it never implies the employee has been told.
      setCredentials(res.data.credentials ? { ...res.data.credentials, name: res.data.name } : null);
      setAdding(null); setOtp(EMPTY_OTP);
      load(); loadOptions();
    } catch (err) {
      setError(err.response?.data?.error || 'That employee could not be created.');
    }
  }

  async function saveRoles() {
    const ok = await run(
      () => api.put(`/employees/management/${roleTarget.id}/roles`, {
        role: roleTarget.role, atsDepartment: roleTarget.atsDepartment, stl: roleTarget.stl, tl: roleTarget.tl,
      }),
      `${roleTarget.name} — roles updated on the same login (${roleTarget.userId}).`,
    );
    if (ok) setRoleTarget(null);
  }

  // --- Edit scope -----------------------------------------------------------
  // Scope is re-resolved from the database on EVERY request
  // (backend/src/middleware/auth.js), so saving here changes what that user can
  // fetch on their very next call — no re-login, no cache to wait out.
  async function saveScope() {
    const ok = await run(
      () => api.put(`/employees/management/${scopeFor.id}/scope`, {
        atsScopeDepartments: scopeFor.atsScopeDepartments || '',
        atsScopeTeams: scopeFor.atsScopeTeams || '',
        atsScopeClients: scopeFor.atsScopeClients || '',
      }),
      `${scopeFor.name} — scope saved. It applies to their next request.`,
    );
    if (ok) setScopeFor(null);
  }

  async function openDetail(id) {
    setError('');
    try { setDetail((await api.get(`/employees/management/${id}`)).data); } catch { setError('Could not open that employee.'); }
  }

  async function submitReset(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/employees/management/${resetFor.id}/reset-password`, { password: resetPassword }),
      `Password reset for ${resetFor.name}. Share it out of band — it is never shown again.`);
    if (ok) { setResetFor(null); setResetPassword(''); }
  }

  const productAccess = (row, product) => (row.productAccess ? row.productAccess[product] : '—');

  return (
    <div>
      <div className="breadcrumb">HRMS / Employee Management</div>
      <div className="page-head">
        <div><h1>Employee Management</h1>
          <div className="page-sub">
            The employee master — records, profile review and department transfers. Logins, product roles
            and data scope are on Administration → Users.
            {scopeText ? <> You are seeing <b>{scopeText}</b>.</> : null}
          </div></div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Three formats, one scoped query behind them. */}
          {caps.export && <>
            <button className="btn" onClick={() => exportAs('csv')} disabled={!!exporting}>{exporting === 'csv' ? 'Exporting…' : 'Export CSV'}</button>
            <button className="btn" onClick={() => exportAs('xlsx')} disabled={!!exporting}>{exporting === 'xlsx' ? 'Exporting…' : 'Export Excel'}</button>
            <button className="btn" onClick={() => exportAs('pdf')} disabled={!!exporting}>{exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}</button>
          </>}
          {caps.create && <button className="btn" onClick={() => setShowImport((s) => !s)}>Bulk Import</button>}
          {caps.create && <button className="btn btn-primary" onClick={openAdd} disabled={!options}>Add Employee</button>}
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
            <b> Validate → Preview → Confirm → Import.</b> Checking the file writes nothing: you see the valid rows
            and every problem, row by row, before you agree to anything. <b>Nothing is written unless every row
            passes</b> — a file with one bad row is refused whole.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontSize: 12.5 }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 2 }}
              checked={importCreateLogins}
              onChange={(e) => { setImportCreateLogins(e.target.checked); setImportPreview(null); }} />
            <span>
              <b>Create logins for these employees</b> — one User and one login each, with the role, product access
              and data scope derived from their designation and department. No password is generated or emailed:
              each person gets a single-use, expiring link to set their own. Every row then needs an email address
              and a known designation.
            </span>
          </label>
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
            <button className="btn btn-sm" disabled={importBusy} onClick={previewImport}>
              {importBusy ? 'Checking…' : 'Check file & preview'}
            </button>{' '}
            <button className="btn btn-primary btn-sm" disabled={importBusy || !importPreview || !importPreview.canImport}
              onClick={confirmImport}>
              {importPreview && importPreview.canImport
                ? `Confirm & import ${importPreview.validCount} row(s)`
                : 'Confirm & import'}
            </button>
            {!importPreview && <span className="small-muted" style={{ marginLeft: 10 }}>Check the file first — the preview is what you confirm.</span>}
          </div>

          {/* THE PREVIEW — valid records and invalid records, side by side. */}
          {importPreview && (
            <div style={{ marginTop: 12 }}>
              <div className={importPreview.canImport ? 'notice' : 'notice amber'}>
                {importPreview.message} Scope: {importPreview.scope}.
              </div>

              {importPreview.invalidCount > 0 && (
                <>
                  <div className="section-label">Invalid Records ({importPreview.invalidCount})</div>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th style={{ width: 70 }}>Row</th><th style={{ width: 130 }}>Field</th><th>Error</th><th>Expected</th></tr></thead>
                      <tbody>
                        {importErrors.map((e, i) => (
                          <tr key={i}>
                            <td><b>{e.row || e.line || '—'}</b></td>
                            <td>{e.field || '—'}</td>
                            <td className="error-text" style={{ margin: 0 }}>{e.message}</td>
                            <td className="cell-muted">{e.expected || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="section-label">Valid Records ({importPreview.validCount})</div>
              {importPreview.validCount === 0
                ? <div className="small-muted">No row in this file can be imported as it stands.</div>
                : (
                  <div className="tbl-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 70 }}>Row</th><th>Name</th><th>Email</th><th>Mobile</th>
                          <th>Department</th><th>Designation</th><th>Location</th><th>Login</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importPreview.valid.map((r) => (
                          <tr key={r.row}>
                            <td className="cell-muted">{r.row}</td>
                            <td><b>{r.name}</b></td>
                            <td className="cell-muted">{r.email || '—'}</td>
                            <td className="cell-muted">{r.phone || '—'}</td>
                            <td className="cell-muted">{r.department || '—'}</td>
                            <td className="cell-muted">{r.designation || '—'}</td>
                            <td className="cell-muted">{r.location || '—'}</td>
                            <td>{r.willCreateLogin
                              ? <span className="status approved">Login + sign-in link</span>
                              : <span className="cell-muted">Record only</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          )}

          {!importPreview && importErrors.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="error-text">
                Nothing was imported. {importErrors.length} problem(s) — fix the file and try again.
              </div>
              <div className="tbl-wrap" style={{ marginTop: 6 }}>
                <table>
                  <thead><tr><th style={{ width: 70 }}>Row</th><th style={{ width: 130 }}>Field</th><th>Error</th><th>Expected</th></tr></thead>
                  <tbody>
                    {importErrors.map((e, i) => (
                      <tr key={i}>
                        <td><b>{e.row || e.line || '—'}</b></td>
                        <td>{e.field || '—'}</td>
                        <td>{e.message}</td>
                        <td className="cell-muted">{e.expected || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {importResult && importResult.ok && (
            <div className="notice" style={{ marginTop: 8 }}>{importResult.message}</div>
          )}
          {importResult && importResult.invites && importResult.invites.length > 0 && (
            <div className="tbl-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Employee</th><th>Email</th><th>Sign-in link</th></tr></thead>
                <tbody>
                  {importResult.invites.map((i, n) => (
                    <tr key={n}>
                      <td>{i.name}</td>
                      <td className="cell-muted">{i.email}</td>
                      <td className={i.sent ? 'cell-muted' : 'error-text'} style={{ margin: 0, wordBreak: 'break-all' }}>
                        {i.status}{!i.sent && i.link ? ` — ${i.link}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {transferTarget && (
        <form className="card section" onSubmit={submitTransfer} style={{ borderColor: 'var(--warn)' }}>
          <h3>Transfer {transferTarget.name}</h3>
          <div className="grid-2">
            <label className="field"><span>Department</span>
              <Combo creatable required value={transferForm.department} onChange={(e) => setTransferForm({ ...transferForm, department: e.target.value, team: '' })}>
                <option value="">Select department</option>
                {deptTree.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </Combo></label>
            {transferTeams.length > 0 && (
              <label className="field"><span>Team</span>
                <Combo creatable value={transferForm.team} onChange={(e) => setTransferForm({ ...transferForm, team: e.target.value })}>
                  <option value="">No team</option>
                  {transferTeams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </Combo></label>
            )}
            <label className="field"><span>Reason (optional)</span>
              <input value={transferForm.reason} onChange={(e) => setTransferForm({ ...transferForm, reason: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Confirm Transfer</button>{' '}
          <button className="btn btn-sm" type="button" onClick={() => setTransferTarget(null)}>Cancel</button>
        </form>
      )}

      {/* FILTERS — search, department, designation, role, employment status and
          login status. They narrow what the server already scoped; they never
          widen it. */}
      <div className="filter-row">
        <input
          type="text" placeholder="Search name, ID or email…"
          value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <Combo value={filters.dept} onChange={(e) => setFilters((f) => ({ ...f, dept: e.target.value }))}>
          <option value="">All departments</option>
          {rowDepts.map((d) => <option key={d}>{d}</option>)}
        </Combo>
        <Combo value={filters.designation} onChange={(e) => setFilters((f) => ({ ...f, designation: e.target.value }))}>
          <option value="">All designations</option>
          {rowDesignations.map((d) => <option key={d}>{d}</option>)}
        </Combo>
        <Combo value={filters.role} onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))}>
          <option value="">All roles</option>
          {rowRoles.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
        </Combo>
        <Combo value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>
          {(options?.statusFilter || ['Active', 'Notice Period', 'Relieved', 'Inactive']).map((s) => <option key={s}>{s}</option>)}
        </Combo>
        <Combo value={filters.login} onChange={(e) => setFilters((f) => ({ ...f, login: e.target.value }))}>
          <option value="">Any login state</option>
          <option>Active</option>
          <option>Inactive</option>
          <option>No login</option>
        </Combo>
        {filtersOn && (
          <button className="btn btn-sm" onClick={() => setFilters({ q: '', dept: '', designation: '', role: '', status: '', login: '' })}>Clear</button>
        )}
        <span className="cell-muted" style={{ alignSelf: 'center', fontSize: 12 }}>{filtered.length} employee(s)</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            {/* THE EIGHT COLUMNS THIS SCREEN IS SPECIFIED TO CARRY. It used to
                show twenty-three, which is why nothing on it lined up and the
                Actions cell wrapped onto four lines. NOTHING WAS DROPPED: the
                other master fields — department, email, mobile, reporting line,
                location, joining date, product access, last login — are all on
                the record behind the name and in the View drawer, and login
                administration (roles, scope, password, sign-in link) moved to
                Administration -> Users, which is the screen that owns logins. */}
            <tr>
              <th style={{ width: 110 }}>Emp ID</th>
              <th>Name</th>
              <th>Designation</th>
              <th style={{ width: 120 }}>Status</th>
              <th style={{ width: 150 }}>Profile Status</th>
              <th>Team</th>
              <th style={{ width: 130 }}>Completion</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const h = hrById[e.id];
              // WAITING ON A DECISION. The employee filled their profile in and
              // pressed Submit for Review, so Approve and Reject appear HERE the
              // moment that happens, rather than only behind a link to another
              // page.
              const awaitingReview = !!(h && h.pendingChanges);
              // ALREADY APPROVED AND LOCKED — so Unlock is the next thing HR
              // reaches for. It reopens the employee's own profile for a bounded
              // window; it is deliberately not offered while a submission is
              // still waiting, because the decision comes first.
              const canUnlock = !!(h && h.isLocked && !awaitingReview);
              const pct = h ? h.profileCompletionPct : null;
              return (
                <tr key={e.id}>
                  <td><b>{e.employeeCode}</b></td>
                  <td className="row-link"><Link to={`/employees/${e.id}`}>{e.name}</Link></td>
                  <td className="cell-muted">{e.designation || '—'}</td>
                  <td>
                    <span className={`status ${(e.employmentStatus || 'Active') === 'Active' ? 'active' : 'pending'}`}>
                      {e.employmentStatus || 'Active'}
                    </span>
                  </td>
                  <td>
                    <span className={`status ${STATUS_BADGE[h?.profileStatus] || ''}`}>
                      {h ? statusLabel(h.profileStatus) : '—'}
                    </span>
                  </td>
                  <td className="cell-muted">{e.team || '—'}</td>
                  <td>
                    {pct == null ? <span className="cell-muted">—</span> : (
                      <span className="pct-cell">
                        <span className="pct-bar"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>
                        <span className="pct-num">{pct}%</span>
                      </span>
                    )}
                  </td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => openDetail(e.id)}>View</button>
                      {caps.edit && <Link className="btn btn-sm" to={`/employees/${e.id}`}>Edit</Link>}
                      {/* THESE TWO APPEAR BY THEMSELVES the moment the employee
                          submits their profile for review. */}
                      {caps.approve && awaitingReview && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => approveProfile(e)}>Approve</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => { setRejectFor(e); setRejectReason(''); }}>Reject</button>
                        </>
                      )}
                      {/* AND THIS ONE APPEARS ONCE THE PROFILE IS APPROVED. */}
                      {caps.approve && canUnlock && (
                        <button
                          className="btn btn-sm"
                          title="Reopen this employee's own profile for a bounded window so they can correct it"
                          onClick={() => { setGrantFor(e); setGrantForm({ hours: 48, section: 'All fields', reason: '' }); }}
                        >
                          Unlock
                        </button>
                      )}
                      {/* TRANSFER stays HERE. Moving somebody between
                          departments or teams is employee-master work, not
                          login administration, so it did not go to Users with
                          the roles, scope and password controls. */}
                      {caps.assign && (
                        <button className="btn btn-sm" onClick={() => { setTransferTarget(e); setTransferForm({ department: e.department || '', team: '', reason: '' }); }}>
                          Transfer
                        </button>
                      )}
                      {caps.configure && (
                        <button className="btn btn-sm" onClick={() => run(() => api.patch(`/employees/${e.id}/toggle-pause`), `${e.name} updated.`)}>
                          {e.employmentStatus === 'On Probation' ? 'Resume' : 'Pause'}
                        </button>
                      )}
                      {caps.delete && (
                        <button className="btn btn-sm btn-ghost" onClick={() => {
                          // eslint-disable-next-line no-alert
                          if (!confirm(`Permanently delete ${e.name}? This removes their attendance, leave, payslip and other records too. This can't be undone.`)) return;
                          run(() => api.delete(`/employees/${e.id}`), `${e.name} deleted.`);
                        }}>Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        One Employee = One User = One Login. Assigning a role here changes product access on the employee&apos;s
        existing login — it never creates a second account.
      </div>
      <div className="notice amber">
        <span>
          <b>Edit Scope</b> and <b>Grant Edit Access</b> are different things. <b>Edit Scope</b> (on the Scope
          column above) sets <i>which records</i> a login may reach — departments, teams and clients — and stays
          until you change it. <b>Grant Edit Access</b> temporarily unlocks <i>that employee&apos;s own profile</i> so
          they can correct it; it expires, it is spent when they submit, and it never lets them see anybody else.
        </span>
      </div>

      {/* REJECT — the API refuses without a reason, because "sent back" is
          useless to the employee unless they are told what to correct. The
          reason lands on their record and in the audit trail. */}
      {rejectFor && (
        <Modal
          title={`Send back for correction — ${rejectFor.name}`}
          onClose={() => { setRejectFor(null); setRejectReason(''); }}
          foot={<>
            <button className="btn" onClick={() => { setRejectFor(null); setRejectReason(''); }}>Cancel</button>
            <button className="btn btn-primary" disabled={!rejectReason.trim()} onClick={submitReject}>Send back</button>
          </>}
        >
          <form onSubmit={submitReject}>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              {rejectFor.name}&apos;s profile goes back to them to correct and submit again. Their status becomes
              <b> Change Requested</b>, and the note below is what they see.
            </div>
            <div className="field">
              <label>What needs correcting? *</label>
              <textarea
                rows="3"
                autoFocus
                value={rejectReason}
                placeholder="e.g. The PAN number does not match the document uploaded."
                onChange={(ev) => setRejectReason(ev.target.value)}
              />
            </div>
          </form>
        </Modal>
      )}

      {grantFor && (
        <Modal
          title={`Grant Edit Access — ${grantFor.name}`}
          onClose={() => setGrantFor(null)}
          foot={<>
            <button className="btn" onClick={() => setGrantFor(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={!grantForm.reason.trim()} onClick={submitGrant}>Grant edit access</button>
          </>}
        >
          <form onSubmit={submitGrant}>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              This reopens <b>{grantFor.name}&apos;s own profile</b> for a bounded time so they can correct it. It does
              not change which records they can see. Everything below is recorded against their record.
            </div>
            <div className="grid-2">
              <label className="field">
                <span>Section to open</span>
                <Combo value={grantForm.section} onChange={(e) => setGrantForm({ ...grantForm, section: e.target.value })}>
                  {(meConfig?.editAccessSections || ['All fields']).map((s) => <option key={s}>{s}</option>)}
                </Combo>
              </label>
              <label className="field">
                <span>Access window (hours)</span>
                <input type="number" min="1" max="720" value={grantForm.hours}
                  onChange={(e) => setGrantForm({ ...grantForm, hours: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Reason</span>
              <input required value={grantForm.reason} onChange={(e) => setGrantForm({ ...grantForm, reason: e.target.value })}
                placeholder="e.g. Bank details changed after the branch merger" />
            </label>
          </form>
        </Modal>
      )}

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
          otp={otp} setOtp={setOtp} emailReady={emailReady} sendOtp={sendOtp} verifyOtp={verifyOtp}
          onClose={() => { setAdding(null); setOtp(EMPTY_OTP); }} onSave={saveNew}
        />
      )}

      {/* EDIT SCOPE — moved here from Administration → Users, which now links
          to this screen instead of carrying a second copy. */}
      {scopeFor && options && (
        <Modal
          title={`Edit scope — ${scopeFor.name}`}
          size="wide"
          onClose={() => setScopeFor(null)}
          foot={<>
            <button className="btn" onClick={() => setScopeFor(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveScope}>Save scope</button>
          </>}
        >
          <div className="notice">
            <span>
              <b>Data scope — which records this login may reach.</b> What the API itself allows them to fetch,
              not what the screen chooses to draw. The server re-resolves it on every request, so a change here
              takes effect on their very next call, without a re-login. Leave a list empty to fall back to the
              employee&apos;s own department and team.
            </span>
          </div>
          <div className="notice amber">
            <span>
              This is <b>not</b> <i>Grant Edit Access</i>. Editing scope changes which <i>other people&apos;s</i>
              {' '}records this login can see and work on, permanently, until you change it again. Grant Edit Access
              temporarily unlocks <i>this person&apos;s own profile</i> so they can correct it, and expires. Neither
              one does the other&apos;s job.
            </span>
          </div>
          <ScopeChecklist
            label="Departments"
            hint="Every list the engine scopes by department — requirements, clients, employees, tasks."
            options={deptTree.map((d) => ({ value: d.name, label: d.name }))}
            value={scopeFor.atsScopeDepartments}
            onChange={(v) => setScopeFor({ ...scopeFor, atsScopeDepartments: v })}
            empty="No departments are set up yet — add them in Administration → Departments & Teams."
          />
          <ScopeChecklist
            label="Teams"
            hint="A team lead held to one team assigns and reviews work inside it."
            options={deptTree.flatMap((d) => (d.teams || []).map((t) => ({
              value: t.name, label: `${t.name} (${d.name})`,
            })))}
            value={scopeFor.atsScopeTeams}
            onChange={(v) => setScopeFor({ ...scopeFor, atsScopeTeams: v })}
            empty="No teams are set up yet."
          />
          <ScopeChecklist
            label="Clients"
            hint="A BDE's assigned client list. It drives which clients and requirements they reach."
            options={(options.clients || []).map((c) => ({ value: c.id, label: c.name }))}
            value={scopeFor.atsScopeClients}
            onChange={(v) => setScopeFor({ ...scopeFor, atsScopeClients: v })}
            empty="No clients yet."
          />
          {['SUPER_ADMIN', 'ADMIN'].includes(scopeFor.role) && (
            <div className="notice amber">
              This login is {atsRoleLabel(scopeFor.role)} — a company-wide role. The engine treats it as global,
              so these lists are stored but do not narrow what it can reach.
            </div>
          )}
        </Modal>
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
            <Combo value={roleTarget.role || 'EMPLOYEE'} onChange={(e) => setRoleTarget({ ...roleTarget, role: e.target.value })}>
              {options.roles.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
            </Combo></div>
          <div className="grid-3">
            <div className="field"><label>HRMS Role</label>
              <input value={(options.productAccess[roleTarget.role] || {}).hrms || '—'} disabled /></div>
            <div className="field"><label>ATS Role</label>
              <input value={(options.productAccess[roleTarget.role] || {}).ats || '—'} disabled /></div>
            <div className="field"><label>Accounts Role</label>
              <input value={(options.productAccess[roleTarget.role] || {}).accounts || '—'} disabled /></div>
          </div>
          <div className="field"><label>Primary department</label>
            <Combo creatable value={roleTarget.atsDepartment || ''} onChange={(e) => setRoleTarget({ ...roleTarget, atsDepartment: e.target.value })}>
              <option value="">Organization</option>
              {options.departments.map((d) => <option key={d}>{d}</option>)}
            </Combo></div>
          <div className="grid-2">
            <div className="field"><label>STL</label>
              <Combo value={roleTarget.stl || ''} onChange={(e) => setRoleTarget({ ...roleTarget, stl: e.target.value })}>
                <option value="">—</option>
                {options.managerNames.map((n) => <option key={n}>{n}</option>)}
              </Combo></div>
            <div className="field"><label>TL</label>
              <Combo value={roleTarget.tl || ''} onChange={(e) => setRoleTarget({ ...roleTarget, tl: e.target.value })}>
                <option value="">—</option>
                {options.managerNames.map((n) => <option key={n}>{n}</option>)}
              </Combo></div>
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            The data scope stays where it is — change it with <b>Edit scope</b> on the Scope column.
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
          <div className="kv"><span className="k">Role</span><span>{detail.role ? atsRoleLabel(detail.role) : '—'}</span></div>
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

// ADD EMPLOYEE — the ONE implementation. It used to sit on Administration →
// Users as a second, thinner form; the two are merged here.
//
// Employee ID is optional and auto-filled when left blank. Department comes
// off the Department master and Role / Designation off the DesignationRole
// master, and those two are what the identity model DERIVES the login's role,
// product access, landing workspace and data scope from — so there is no
// compound role like "Medical Recruiter" to choose anywhere.
function AddEmployeeModal({
  form, setForm, options, employees, otp, setOtp, emailReady, sendOtp, verifyOtp, onClose, onSave,
}) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const chosen = (options.designations || []).find((d) => d.designation === form.designation);
  const access = chosen
    ? {
      hrms: chosen.products.hrms ? 'Yes' : 'No Access',
      ats: chosen.products.ats ? (chosen.atsRole || 'Yes') : 'No Access',
      accounts: chosen.products.accounts ? 'Yes' : 'No Access',
    }
    : { hrms: '—', ats: '—', accounts: '—' };
  const scope = form.department ? `${form.department}${form.team ? ` · team ${form.team}` : ''}` : '—';
  const canSave = form.name.trim() && form.email.trim() && form.department && form.designation
    && (!emailReady || otp.verified);

  return (
    <Modal
      title="Add Employee"
      note={`${options.nextEmployeeCode || ''} · the employee record and their login are created together`}
      size="wide"
      onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!canSave} onClick={onSave}>Create Employee &amp; Login</button>
      </>}
    >
      <div className="section-label">Identity</div>
      <div className="grid-3">
        <div className="field"><label>Employee ID <i style={{ fontWeight: 400 }}>(optional — auto if blank)</i></label>
          <input value={form.employeeId} onChange={(e) => set({ employeeId: e.target.value })}
            placeholder={`e.g. ${options.nextEmployeeCode || 'EMP-0009'}`} /></div>
        <div className="field"><label>Full name *</label>
          <input type="text" placeholder="As it should appear on records" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="field"><label>Date of birth</label>
          <input type="date" value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} /></div>
        <div className="field"><label>Gender</label>
          <Combo value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
            {options.genders.map((g) => <option key={g}>{g}</option>)}
          </Combo></div>
      </div>

      <div className="section-label">Position — this is what the role and the scope are derived from</div>
      <div className="grid-3">
        {/* Department master. It becomes the login's data scope. */}
        <div className="field"><label>Department *</label>
          <Combo creatable value={form.department} onChange={(e) => set({ department: e.target.value })}>
            <option value="">Select department</option>
            {options.departments.map((d) => <option key={d}>{d}</option>)}
          </Combo></div>
        {/* DesignationRole master. It gives the ATS role, the product access
            and the landing workspace — never typed free-hand. */}
        <div className="field"><label>Role / Designation *</label>
          <Combo value={form.designation} onChange={(e) => set({ designation: e.target.value })}>
            <option value="">Select role / designation</option>
            {(options.designations || []).map((d) => (
              <option key={d.designation} value={d.designation}>
                {d.designation}{d.atsRole ? ` — ATS ${atsRoleLabel(d.atsRole)}` : ''}
              </option>
            ))}
          </Combo></div>
        <div className="field"><label>Team</label>
          <input type="text" placeholder="e.g. Medical Team-A" value={form.team} onChange={(e) => set({ team: e.target.value })} /></div>
        <div className="field"><label>Reporting manager</label>
          <Combo value={form.reportingManagerId} onChange={(e) => set({ reportingManagerId: e.target.value })}>
            <option value="">—</option>
            {employees.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Combo></div>
        <div className="field"><label>STL</label>
          <Combo value={form.stl} onChange={(e) => set({ stl: e.target.value })}>
            <option value="">—</option>
            {options.managerNames.map((n) => <option key={n}>{n}</option>)}
          </Combo></div>
        <div className="field"><label>TL</label>
          <Combo value={form.tl} onChange={(e) => set({ tl: e.target.value })}>
            <option value="">—</option>
            {options.managerNames.map((n) => <option key={n}>{n}</option>)}
          </Combo></div>
      </div>

      <div className="section-label">Contact</div>
      <div className="grid-2">
        {/* THE EMAIL GATE. A code goes to the address before the account
            exists — and where there is no channel the button says exactly
            that instead of pretending one was sent. */}
        <label className="field"><span>Official email *</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="email" style={{ flex: 1 }} placeholder="name@tmlink.in"
              value={form.email}
              onChange={(e) => { set({ email: e.target.value }); setOtp({ sending: false, sent: false, code: '', verified: false, message: '', error: '' }); }}
            />
            <button
              type="button" className="btn btn-sm"
              disabled={!emailReady || !form.email || otp.sending}
              title={emailReady ? 'Email a one-time code to this address' : (options.email?.reason || '')}
              onClick={sendOtp}
            >
              {emailReady
                ? (otp.sending ? 'Sending…' : (otp.sent ? 'Resend OTP' : 'Send OTP'))
                : 'No email channel — can’t send OTP'}
            </button>
          </div>
          {!emailReady && (
            <span className="small-muted">
              No SMTP provider is configured, so no code can be sent — {options.email?.reason} The
              employee can still be created, and the address stays unverified.
            </span>
          )}
          {otp.message && <span className="small-muted">{otp.message}</span>}
          {otp.error && <span className="error-text">{otp.error}</span>}
          {otp.sent && !otp.verified && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input
                style={{ flex: 1 }} inputMode="numeric" maxLength="6" placeholder="6-digit code"
                value={otp.code} onChange={(e) => setOtp({ ...otp, code: e.target.value })}
              />
              <button type="button" className="btn btn-sm" onClick={verifyOtp} disabled={!otp.code}>Verify</button>
            </div>
          )}
          {otp.verified && <span className="status approved" style={{ marginTop: 6 }}>Email verified</span>}
        </label>
        <div className="field"><label>Mobile</label>
          <input type="text" placeholder="10 digits" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></div>
        <div className="field"><label>Location</label>
          <Combo creatable value={form.location} onChange={(e) => set({ location: e.target.value })}>
            <option value="">—</option>
            {options.locations.map((l) => <option key={l}>{l}</option>)}
          </Combo></div>
      </div>

      <div className="section-label">Employment</div>
      <div className="grid-3">
        <div className="field"><label>Date of joining</label>
          <input type="date" value={form.dateOfJoining} onChange={(e) => set({ dateOfJoining: e.target.value })} /></div>
        <div className="field"><label>Employment type</label>
          <Combo value={form.employeeType} onChange={(e) => set({ employeeType: e.target.value })}>
            {options.empTypes.map((t) => <option key={t}>{t}</option>)}
          </Combo></div>
        <div className="field"><label>Status</label>
          <Combo value={form.employmentStatus} onChange={(e) => set({ employmentStatus: e.target.value })}>
            {options.empStatuses.map((s) => <option key={s}>{s}</option>)}
          </Combo></div>
        {/* Optional and discouraged. Leave it empty and the employee gets a
            single-use, expiring link to choose their own password — no
            password is ever emailed, and the account has no guessable default
            in the meantime. */}
        <div className="field"><label>Temporary password (leave empty — recommended)</label>
          <input type="password" placeholder="leave empty to email a set-password link" value={form.password}
            onChange={(e) => set({ password: e.target.value })} /></div>
      </div>

      {/* What this person will actually be able to do, shown before saving. */}
      <div className="notice" style={{ marginTop: 10 }}>
        <span>
          Login role → <b>{chosen ? atsRoleLabel(chosen.atsRole || 'EMPLOYEE') : '—'}</b>
          &nbsp;&nbsp;·&nbsp;&nbsp;HRMS → {access.hrms}&nbsp;&nbsp;·&nbsp;&nbsp;ATS → {access.ats}
          &nbsp;&nbsp;·&nbsp;&nbsp;Accounts → {access.accounts}&nbsp;&nbsp;·&nbsp;&nbsp;Scope: {scope}.
          All derived from the department and the designation — one login covers all three products, and no
          second account is created.
        </span>
      </div>
    </Modal>
  );
}

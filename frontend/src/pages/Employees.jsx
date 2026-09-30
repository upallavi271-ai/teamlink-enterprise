import { useEffect, useMemo, useRef, useState } from 'react';
import { PasswordBadge, PasswordStatusRows } from '../components/PasswordStatus.jsx';
import { HR_STATUSES, hrStatusOf } from '../hrStatus';
// "Apr 2026" — seat dates are YYYY-MM-DD strings.
const seatMonth = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '');
import { Link } from 'react-router-dom';
import EmployeePhoto from '../components/EmployeePhoto.jsx';
import api from '../api';
import Pager, { usePaged } from '../components/Pager.jsx';
import Modal from '../components/Modal.jsx';
import { atsRoleLabel, registerRoleLabels } from '../atsVocab';
import { STATUS_BADGE, statusLabel } from '../components/ProfileStatusBanner.jsx';
import Combo from '../components/Combo.jsx';
import EmployeeBulkImport from '../components/employees/EmployeeBulkImport.jsx';
import GlobalExportPanel from '../components/employees/GlobalExportPanel.jsx';
// Template export / import (every form field), for everyone who can open this
// screen — scoped; view-only roles send an import REQUEST (Super Admin approves).
import DataIoBar from '../components/dataio/DataIoBar.jsx';
import { useMasters } from '../utils/masters';
import ImportRequests from '../components/dataio/ImportRequests.jsx';
import TlWiseView from '../components/employees/TlWiseView.jsx';
// List avatar (lazy, cached), transfer history and the documents panel.
import EmployeeAvatar from '../components/employees/EmployeeAvatar.jsx';
import TransferHistory from '../components/employees/TransferHistory.jsx';
import EmployeeDocuments from '../components/EmployeeDocuments.jsx';
import '../components/employees/EmpMgmtExtras.css';
// "12 Oct 2026" for a YYYY-MM-DD last working date.
const lwdLabel = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const ON_NOTICE = ['Notice Period', 'Exit Process'];
// The list's horizontal scrollbar at the TOP as well as the bottom.
import ScrollTable from '../components/ScrollTable.jsx';
import { ViewAsButton } from '../components/ViewAs.jsx';

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
  department: '', departments: [], designation: '', reportingManagerId: '', stl: '', tl: '', team: '',
  // The Role dropdown (roles are data — Role Catalog). '' = the designation's own roles.
  roleCode: '',
  position: '',
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
    // Opens on the people who work here now: after the PulseHRM import 319 of
    // 359 records are people who have left.
    q: '', dept: '', designation: '', role: '', status: 'Active', login: '', position: '',
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
  // Bulk Import (Sample Excel, .xlsx/.csv upload, row-wise checks, valid rows
  // only) lives in components/employees/EmployeeBulkImport.jsx.
  // GLOBAL EXPORT — the Export Fields panel (components/employees/GlobalExportPanel.jsx).
  const [showGlobalExport, setShowGlobalExport] = useState(false);
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
  // The employee just created — Add Employee makes the record and the login;
  // their documents are attached on the record itself, so say where.
  const [justCreated, setJustCreated] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferForm, setTransferForm] = useState({ department: '', team: '', reason: '' });
  // The inline Reject dialog. Rejecting needs a REASON — the API refuses
  // without one, because the employee has to be told what to correct.
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Employees list | TL-wise summary.
  const [view, setView] = useState('list');
  // CHANGE EMPLOYEE ID — HR / Super Admin (caps.editCode).
  const [codeFor, setCodeFor] = useState(null);
  const [codeForm, setCodeForm] = useState({ employeeCode: '', reason: '' });
  // Last working date draft in the View drawer (HR / Super Admin — caps.lastWorkingDate).
  const [lwdDraft, setLwdDraft] = useState('');

  function load() {
    api.get('/employees/management').then((res) => {
      setRows(res.data.rows || []);
      setCaps(res.data.caps || {});
      setScopeText(res.data.scope || '');
      setEmployeeIds((res.data.rows || []).map((r) => ({ id: r.id, name: r.name, code: r.employeeCode })));
    }).catch((err) => setError(err.response?.data?.error || 'Employee Management is not included in your role’s permissions.'));
    // profileStage / isLocked / completion come off the HR record.
    api.get('/employees').then((res) => setHr(res.data)).catch(() => setHr([]));
    api.get('/employees/review-queue').then((res) => setQueue(res.data)).catch(() => setQueue(null));
  }
  function loadOptions() {
    api.get('/employees/management/options').then((res) => {
      registerRoleLabels(res.data.roleCatalog);
      setOptions(res.data);
    }).catch(() => setOptions(null));
  }
  useEffect(() => {
    load();
    loadOptions();
    api.get('/employees/me/config').then((res) => setMeConfig(res.data)).catch(() => setMeConfig(null));
  }, []);
  // A role / department / designation added in the masters appears in this
  // screen's pickers by itself: the options re-load when the masters change.
  const masters = useMasters();
  const mastersVersion = masters && masters.version;
  const seenVersion = useRef(null);
  useEffect(() => {
    if (!mastersVersion) return;
    if (seenVersion.current && seenVersion.current !== mastersVersion) loadOptions();
    seenVersion.current = mastersVersion;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mastersVersion]);

  async function run(fn, message) {
    setError(''); setNotice('');
    try { await fn(); if (message) setNotice(message); load(); return true; } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
      return false;
    }
  }

  // APPROVE / REJECT, inline on the row. Same two endpoints the record page
  // uses — this is a second way in, not a second implementation.
  // APPROVING THE REQUEST TO EDIT. This only records the decision — the window
  // is opened separately by Unlock, which is the next button to appear on the
  // row.
  async function approveRequest(e) {
    await run(() => api.patch(`/employees/${e.id}/unlock-request/approve`),
      `${e.name}'s edit request approved. Click Unlock on their row to open the profile.`);
  }

  async function approveProfile(e) {
    await run(() => api.patch(`/employees/${e.id}/changes/approve`),
      `${e.name}'s profile approved. It is locked again, and Unlock is on the row if they need to correct something.`);
  }

  // One dialog, two decisions. `kind` says which was waiting when Reject was
  // pressed; both endpoints refuse without a reason, for the same reason.
  async function submitReject(ev) {
    ev.preventDefault();
    const isRequest = rejectFor.kind === 'request';
    const url = isRequest
      ? `/employees/${rejectFor.id}/unlock-request/reject`
      : `/employees/${rejectFor.id}/changes/reject`;
    const ok = await run(() => api.patch(url, { reason: rejectReason.trim() }),
      isRequest
        ? `${rejectFor.name}'s edit request was declined, with your note.`
        : `Sent back to ${rejectFor.name} with your note.`);
    if (ok) { setRejectFor(null); setRejectReason(''); }
  }

  // A POSITION (MED-1, EDU-6 …) lists EVERYONE who held it — the person in
  // it today and every earlier holder — whatever the status filter says, in
  // the order they sat in it.
  const tenureIn = (e, code) => [...(e.seats || [])].reverse().find((t) => t.code === code) || null;
  // `ignoreStatus`: the TL-wise view counts every status (its columns ARE the
  // status split), under all the other filters.
  const matchesFilters = (e, ignoreStatus = false) => {
    if (filters.position && !(e.seats || []).some((t) => t.code === filters.position)) return false;
    const q = filters.q.trim().toLowerCase();
    if (q && !`${e.name} ${e.employeeCode} ${e.email || ''}`.toLowerCase().includes(q)) return false;
    if (filters.dept && e.department !== filters.dept) return false;
    if (filters.designation && e.designation !== filters.designation) return false;
    if (filters.role && (e.role || '') !== filters.role
      && !Object.values(e.productRoles || {}).includes(filters.role)) return false;
    if (!ignoreStatus && !filters.position && filters.status && hrStatusOf(e.employmentStatus, e.loginStatus) !== filters.status) return false;
    if (filters.login && e.loginStatus !== filters.login) return false;
    return true;
  };
  const filtered = useMemo(() => rows.filter((e) => matchesFilters(e)).sort((a, b) => (filters.position
    ? (tenureIn(a, filters.position)?.from || '').localeCompare(tenureIn(b, filters.position)?.from || '')
    : 0)), [rows, filters]); // eslint-disable-line react-hooks/exhaustive-deps
  const tlWiseIds = useMemo(() => rows.filter((e) => matchesFilters(e, true)).map((e) => e.id), [rows, filters]); // eslint-disable-line react-hooks/exhaustive-deps
  // The Positions dropdown: every seat anyone has held, in the chosen
  // department, with how many people have sat in it.
  const positionOptions = useMemo(() => {
    const count = new Map();
    rows.forEach((e) => (e.seats || []).forEach((t) => {
      if (filters.dept && t.department && t.department !== filters.dept) return;
      if (!count.has(t.code)) count.set(t.code, new Set());
      count.get(t.code).add(e.id);
    }));
    return [...count.entries()].map(([code, ids]) => ({ code, n: ids.size }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [rows, filters.dept]);

  // 257 employee records after the import, so the table shows a page at a
  // time. `filtered` stays whole for the counts and the filter dropdowns.
  const pagedEmployees = usePaged(filtered);
  // How many people sit in each of the five HRMS statuses — shown in the
  // status dropdown beside each choice.
  const statusCounts = useMemo(() => {
    const out = {};
    HR_STATUSES.forEach((st) => { out[st] = 0; });
    rows.forEach((e) => { out[hrStatusOf(e.employmentStatus, e.loginStatus)] += 1; });
    return out;
  }, [rows]);
  const rowDepts = useMemo(() => [...new Set(rows.map((e) => e.department).filter(Boolean))].sort(), [rows]);
  // Every configured designation (incl. Role Catalog custom roles), not only
  // the ones somebody already holds — a role added a minute ago is filterable.
  const rowDesignations = useMemo(() => [...new Set([
    ...rows.map((e) => e.designation),
    ...(options?.designations || []).map((d) => d.designation),
  ].filter(Boolean))].sort(), [rows, options]);
  // Account-level and product roles on file, plus every active role on the
  // registry (custom roles included) — never a hard-coded list.
  const rowRoles = useMemo(() => [...new Set([
    ...rows.map((e) => e.role),
    ...rows.flatMap((e) => Object.values(e.productRoles || {})),
    ...(options?.roleCatalog || []).map((r) => r.code),
  ].filter((r) => r && r !== 'NONE'))].sort(), [rows, options]);
  const hrById = useMemo(() => Object.fromEntries(hr.map((e) => [e.id, e])), [hr]);
  const deptTree = options?.departmentTree || [];
  const transferTeams = deptTree.find((d) => d.name === transferForm.department)?.teams || [];
  const filtersOn = Object.values(filters).some(Boolean);
  // PEOPLE WHO HELD A SEAT HERE BUT ARE HIDDEN by the status filter — after a
  // department is picked, the list opens on today's team, and the ones they
  // took over from must be one click away, not invisible.
  const hiddenHolders = useMemo(() => (filters.status && !filters.position ? rows.filter((e) => e.seatCount > 0
    && (!filters.dept || e.department === filters.dept)
    && hrStatusOf(e.employmentStatus, e.loginStatus) !== filters.status) : []), [rows, filters.status, filters.dept, filters.position]);

  // The server builds the file and scopes it: a TL downloads their own
  // department, not the company. The browser only saves what comes back, so
  // CSV, Excel and PDF all carry the same rows and the same permission.
  function saveBlob(res, fallback) {
    const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || fallback;
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove();
  // Released a moment later: revoking at once can cancel the download and
  // leave an empty file in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
    return name;
  }
  // THE LIST, AS EXCEL — exactly the rows the filters are showing now.
  async function exportAs() {
    setError(''); setNotice(''); setExporting('list');
    try {
      const res = await api.post('/employees/export.xlsx', { ids: filtered.map((e) => e.id) }, { responseType: 'blob' });
      const name = saveBlob(res, 'employees.xlsx');
      setNotice(`Exported ${name} — ${filtered.length} employee(s), as filtered on screen.`);
    } catch {
      setError('Export is not included in your role’s permissions.');
    } finally { setExporting(''); }
  }
  // ONE EMPLOYEE'S FULL RECORD, AS EXCEL — the row action. A role without the
  // export permission (view-only) gets the same person in the import TEMPLATE
  // columns instead (scoped, sensitive fields masked by the server).
  async function exportOne(e) {
    setError(''); setNotice(''); setExporting(e.id);
    try {
      const res = caps.export
        ? await api.get(`/employees/${e.id}/export.xlsx`, { responseType: 'blob' })
        : await api.get('/io/employees/export', { params: { employeeId: e.id, format: 'xlsx' }, responseType: 'blob' });
      const name = saveBlob(res, `${e.employeeCode}.xlsx`);
      setNotice(`Exported ${name} — ${e.name}'s full record, positions and documents.`);
    } catch {
      setError(`Could not export ${e.name}'s record.`);
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

  // CHANGE EMPLOYEE ID — unique in any case, audited old -> new on the record.
  async function submitCode(ev) {
    if (ev) ev.preventDefault();
    setError(''); setNotice('');
    try {
      const res = await api.put(`/employees/management/${codeFor.id}/code`, {
        employeeCode: codeForm.employeeCode.trim(), reason: codeForm.reason.trim(),
      });
      setNotice(`${codeFor.name}'s Employee ID changed ${res.data.from} → ${res.data.to}.${res.data.warning ? ` Note: ${res.data.warning}` : ''}`);
      setCodeFor(null);
      load(); loadOptions();
    } catch (err) {
      setError(err.response?.data?.error || 'The Employee ID could not be changed.');
    }
  }
  const codeDraft = codeForm.employeeCode.trim();
  const codeClash = codeFor && codeDraft && rows.find((r) => r.id !== codeFor.id && r.employeeCode.toLowerCase() === codeDraft.toLowerCase());

  // --- Add Employee ---------------------------------------------------------
  // A code goes to the address BEFORE the account exists. Where no SMTP
  // channel is configured the button says so and nothing is sent — the form
  // never pretends otherwise.
  const emailReady = !!options?.email?.configured;

  function openAdd() {
    setOtp(EMPTY_OTP);
    setCredentials(null);
    setJustCreated(null);
    // EMPLOYEE ID PRE-FILLED with the next one in the series (TL516 -> TL517),
    // editable. Re-read on open: somebody may have added a person since the
    // options loaded.
    const suggested = options?.nextEmployeeCode || '';
    setAdding({
      ...EMPTY_NEW, employeeId: suggested, suggestedId: suggested,
      department: options?.departments?.length === 1 ? options.departments[0] : '',
    });
    api.get('/employees/next-code').then((res) => {
      const fresh = res.data?.nextEmployeeCode;
      if (!fresh) return;
      setAdding((f) => (f && f.employeeId === f.suggestedId ? { ...f, employeeId: fresh, suggestedId: fresh } : f));
    }).catch(() => {});
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

  // `keepOpen` — the Add form has documents waiting: it stays open after the
  // employee is created so it can upload them and show each file's result.
  // Returns the created employee (or null when the create was refused).
  async function saveNew({ keepOpen = false } = {}) {
    setError(''); setNotice(''); setCredentials(null);
    try {
      // The untouched suggestion goes as blank, so the SERVER allocates the
      // next free ID at the moment of saving (two people adding at once
      // cannot both get TL517). A typed ID is sent as typed.
      const { suggestedId, ...body } = adding;
      if (body.employeeId.trim() === (suggestedId || '')) body.employeeId = '';
      const res = await api.post('/employees/management', body);
      setNotice(`${res.data.name} (${res.data.employeeCode}) created — employee record and login together.`
        + ` Role ${atsRoleLabel(res.data.login.role)}${res.data.login.atsRole ? ` · ATS ${atsRoleLabel(res.data.login.atsRole)}` : ''}`
        + ` · scope ${res.data.login.scope}. Email ${res.data.emailChannel}.`);
      // What actually happened to the sign-in email, verbatim from the server.
      // When there is no SMTP provider this says so and hands over the link;
      // it never implies the employee has been told.
      setCredentials(res.data.credentials ? { ...res.data.credentials, name: res.data.name } : null);
      setJustCreated({ id: res.data.id, name: res.data.name });
      if (!keepOpen) { setAdding(null); setOtp(EMPTY_OTP); }
      load(); loadOptions();
      return res.data;
    } catch (err) {
      setError(err.response?.data?.error || 'That employee could not be created.');
      return null;
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
    try {
      const d = (await api.get(`/employees/management/${id}`)).data;
      setDetail(d);
      setLwdDraft(d.lastWorkingDate || '');
    } catch { setError('Could not open that employee.'); }
  }

  // LAST WORKING DATE — written onto the resignation record (created, already
  // serving notice, when the person resigned outside TeamLink).
  async function saveLwd() {
    setError(''); setNotice('');
    try {
      await api.put(`/employees/management/${detail.id}/last-working-date`, { lastWorkingDate: lwdDraft });
      setNotice(`${detail.name}'s last working date set to ${lwdLabel(lwdDraft)}.`);
      load(); openDetail(detail.id);
    } catch (err) {
      setError(err.response?.data?.error || 'The last working date could not be saved.');
    }
  }

  async function submitReset(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/employees/management/${resetFor.id}/reset-password`, { password: resetPassword }),
      `Password reset for ${resetFor.name}. Share it out of band — it is never shown again. They must change it at their next sign-in.`);
    if (ok) { setResetFor(null); setResetPassword(''); }
  }

  // SEND PASSWORD RESET (hrms-24 §12) — a single-use set-password link, emailed
  // from the company mailbox. HR never learns the new password. When it could
  // not be emailed the screen says why and hands the link over once.
  async function sendReset(emp) {
    setError(''); setNotice('');
    try {
      const res = await api.post(`/employees/management/${emp.id}/send-password-reset`, {});
      setNotice(res.data.sent
        ? `Password reset link emailed to ${emp.name}. ${res.data.status}`
        : `Reset link NOT emailed — ${res.data.status}${res.data.link ? ` Pass this single-use link to ${emp.name} yourself: ${res.data.link}` : ''}`);
      load();
      if (detail && detail.id === emp.id) openDetail(emp.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the password reset.');
    }
  }

  const productAccess = (row, product) => (row.productAccess ? row.productAccess[product] : '—');

  return (
    <div>
      <div className="page-head">
        <div><h1>Employee Management</h1>
          <div className="page-sub">
            The employee master — records, profile review and department transfers. Logins, product roles
            and data scope are on Administration → Users.
            {scopeText ? <> You are seeing <b>{scopeText}</b>.</> : null}
          </div></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
          {/* The list as Excel — the rows the filters show, scoped server-side. */}
          {caps.export && (
            <button className="btn" onClick={exportAs} disabled={!!exporting} title="Download the employees shown below as an Excel file">
              {exporting === 'list' ? 'Exporting…' : `Export Excel (${filtered.length})`}
            </button>
          )}
          {/* GLOBAL EXPORT — pick the fields; same scope and filters as the list. */}
          {caps.export && (
            <button className="btn btn-primary" onClick={() => setShowGlobalExport(true)} title="Choose the fields and export everyone the current filters show, within your scope">
              ⬇ Global Export
            </button>
          )}
          {/* EXPORT / IMPORT in the template columns — every role that can open
              this screen; the server scopes the rows and decides direct import
              (Super Admin / Admin / HR) vs an import request (everyone else). */}
          <DataIoBar
            ioKey="employees"
            size="md"
            exportLabel="Export (template)"
            params={{ q: filters.q, dept: filters.dept, designation: filters.designation, role: filters.role, status: filters.status, login: filters.login }}
            onImported={() => load()}
          />
          {caps.create && <button className="btn" title="Create new employees with logins from the short sample (sign-in links, no passwords)" onClick={() => setShowImport((s) => !s)}>Bulk create + logins</button>}
          {caps.create && <button className="btn btn-primary" onClick={openAdd} disabled={!options}>Add Employee</button>}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}
      {caps.viewOnly && (
        <div className="notice emgx-viewonly">
          <span>You are viewing <b>every department</b>, <b>view only</b> — records, documents and exports can be
            opened; adding, editing, deleting and ID changes are for HR and the Super Admin.</span>
        </div>
      )}
      {justCreated && (
        <div className="notice" style={{ marginBottom: 12 }}>
          Next: <Link to={`/employees/${justCreated.id}`}>attach {justCreated.name}&apos;s documents</Link> — Aadhaar, PAN,
          certificates and joining paperwork go on their employee record.
        </div>
      )}

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

      {showImport && <EmployeeBulkImport onImported={load} />}
      {/* Import requests: the Super Admin's queue; everyone else sees their own. */}
      <ImportRequests ioKey="employees" onChanged={load} />

      {showGlobalExport && (
        <GlobalExportPanel
          filters={filters}
          shownCount={filtered.length}
          onClose={() => setShowGlobalExport(false)}
          onDone={(msg) => { setShowGlobalExport(false); setError(''); setNotice(msg); }}
        />
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

      {/* THE TWO VIEWS of the same scoped list: every employee, or grouped by TL. */}
      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>Employees ({filtered.length})</div>
        <div className={`tab${view === 'tl' ? ' active' : ''}`} onClick={() => setView('tl')}>TL-wise</div>
      </div>

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
        <Combo value={filters.position} onChange={(e) => setFilters((f) => ({ ...f, position: e.target.value }))}>
          <option value="">All positions</option>
          {positionOptions.map((o) => <option key={o.code} value={o.code}>{`${o.code} · ${o.n} ${o.n === 1 ? 'person' : 'people'}`}</option>)}
        </Combo>
        <Combo value={filters.role} onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))}>
          <option value="">All roles</option>
          {rowRoles.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
        </Combo>
        <Combo value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses ({rows.length})</option>
          {HR_STATUSES.map((st) => <option key={st} value={st}>{`${st} (${statusCounts[st] ?? 0})`}</option>)}
        </Combo>
        <Combo value={filters.login} onChange={(e) => setFilters((f) => ({ ...f, login: e.target.value }))}>
          <option value="">Any login state</option>
          <option>Active</option>
          <option>Inactive</option>
          <option>No login</option>
        </Combo>
        {filtersOn && (
          <button className="btn btn-sm" onClick={() => setFilters({ q: '', dept: '', designation: '', role: '', status: '', login: '', position: '' })}>Clear</button>
        )}
        <span className="cell-muted" style={{ alignSelf: 'center', fontSize: 12 }}>
          {view === 'tl' ? `${tlWiseIds.length} employee(s), all statuses` : `${filtered.length} employee(s)`}
        </span>
      </div>
      {view === 'tl' && (
        <TlWiseView
          ids={tlWiseIds}
          canExport={!!caps.export}
          onNotice={(m) => { setError(''); setNotice(m); }}
          onError={(m) => setError(m)}
        />
      )}
      {view === 'list' && hiddenHolders.length > 0 && (
        <div className="notice" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            <b>{hiddenHolders.length}</b> earlier position holder{hiddenHolders.length === 1 ? '' : 's'}
            {filters.dept ? ` in ${filters.dept}` : ''} {hiddenHolders.length === 1 ? 'is' : 'are'} not {filters.status} —{' '}
            {hiddenHolders.slice(0, 4).map((e) => e.name).join(', ')}{hiddenHolders.length > 4 ? '…' : ''}
          </span>
          <button className="btn btn-sm" onClick={() => setFilters((f) => ({ ...f, status: '' }))}>Show everyone</button>
          <Link className="btn btn-sm btn-ghost" to="/admin/positions?tab=history">Seat history</Link>
        </div>
      )}

      {view === 'list' && (<>
      {/* Horizontal scrollbar at the TOP too (synced), sticky header, box
          capped to the viewport (.tbl-fit) so the bottom bar stays in view. */}
      <ScrollTable maxHeight={null} bodyClassName="tbl-fit">
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
              <th style={{ width: 70 }}>Docs</th>
              <th>Designation · Team</th>
              <th style={{ width: 150 }}>Status</th>
              <th style={{ width: 150 }}>Profile Status</th>
              <th>Position · Handover</th>
              <th style={{ width: 130 }}>Completion</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pagedEmployees.slice.map((e) => {
              const h = hrById[e.id];
              // THE LIFECYCLE, IN THE ORDER IT ACTUALLY HAPPENS:
              //
              //   employee asks for edit access   -> Approve / Reject
              //   HR approves the request         -> UNLOCK
              //   HR unlocks                      -> they edit, window open
              //   they submit                     -> Approve / Reject
              //   HR approves                     -> LOCKED again, no edit
              //
              // Unlock is deliberately NOT offered on any locked profile. It
              // appears only once a request has been approved, which is what
              // "approve click chesthey appudu unlock ani button kanipinchali"
              // means — otherwise HR could reopen a profile nobody asked to
              // change.
              const requestPending = h && h.unlockRequestStatus === 'Pending';
              const submittedForReview = !!(h && h.pendingChanges);
              // Either decision point puts Approve / Reject on the row.
              const awaitingDecision = !!(requestPending || submittedForReview);
              const requestApproved = h && h.unlockRequestStatus === 'Approved';
              const windowOpen = !!(h && h.unlockExpiresAt && new Date(h.unlockExpiresAt) > new Date());
              const canUnlock = !!(requestApproved && !windowOpen && !submittedForReview);
              const pct = h ? h.profileCompletionPct : null;
              return (
                <tr key={e.id}>
                  <td><b>{e.employeeCode}</b></td>
                  <td className="row-link">
                    <div className="emgx-name">
                      <EmployeeAvatar employeeId={e.id} photoDocId={e.photoDocId} name={e.name} />
                      <div>
                        <Link to={`/employees/${e.id}`}>{e.name}</Link>
                        {e.email && !e.emailVerified && <div className="small-muted" style={{ fontSize: 11 }} title={`${e.email} has not been verified by code`}>✉ email not verified</div>}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`emgx-docs${e.docCount ? '' : ' none'}`} title="Documents on this employee's file — open View to see them">
                      {e.docCount ? `${e.docCount} doc${e.docCount === 1 ? '' : 's'}` : 'No docs'}
                    </span>
                  </td>
                  <td className="cell-muted">
                    {e.designation || '—'}
                    {e.team && <div style={{ fontSize: 11.5 }}>{e.team}</div>}
                  </td>
                  <td>
                    <span className={`status ${(e.employmentStatus || 'Active') === 'Active' ? 'active' : 'pending'}`}>
                      {e.employmentStatus || 'Active'}
                    </span>
                    {ON_NOTICE.includes(e.employmentStatus) && (
                      <div className={`emgx-lwd${e.lastWorkingDate ? '' : ' missing'}`} title={e.lastWorkingDateSource || 'No last working date recorded — set it from View'}>
                        Last working date: {e.lastWorkingDate ? lwdLabel(e.lastWorkingDate) : 'not set'}
                      </div>
                    )}
                    {/* Password / account status (hrms-24 §12). */}
                    {e.passwordStatus && <div style={{ marginTop: 4 }}><PasswordBadge ps={e.passwordStatus} /></div>}
                  </td>
                  <td>
                    <span className={`status ${STATUS_BADGE[h?.profileStatus] || ''}`}>
                      {h ? statusLabel(h.profileStatus) : '—'}
                    </span>
                  </td>
                  <td>
                    {(() => {
                      const st = filters.position ? tenureIn(e, filters.position) : e.seat;
                      if (!st) return <span className="cell-muted">—</span>;
                      return (
                        <div style={{ lineHeight: 1.35 }}>
                          <b>{st.code}</b>
                          {filters.position && (
                            <span className={`status ${st.current ? 'active' : 'pending'}`} style={{ marginLeft: 6, fontSize: 10.5 }}>
                              {st.current ? 'Current' : 'Previous'}
                            </span>
                          )}
                          <span className="small-muted">
                            {' '}{seatMonth(st.from)} – {st.current ? 'today' : seatMonth(st.to)}
                            {!filters.position && e.seatCount > 1 ? ` · ${e.seatCount} seats` : ''}
                          </span>
                          {st.tookOverFrom && (
                            <div className="small-muted" style={{ fontSize: 11.5 }}>← took over from <b>{st.tookOverFrom.name}</b></div>
                          )}
                          {st.handedTo && (
                            <div className="small-muted" style={{ fontSize: 11.5 }}>→ handed to <b>{st.handedTo.name}</b> ({seatMonth(st.handedTo.from)})</div>
                          )}
                        </div>
                      );
                    })()}
                  </td>
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
                      {/* Super Admin only (renders nothing for anyone else). */}
                      <ViewAsButton userId={e.userId} name={e.name} active={e.loginStatus === 'Active'} />
                      {caps.edit && <Link className="btn btn-sm" to={`/employees/${e.id}?edit=1`} title="Open the full employee form">Edit</Link>}
                      {caps.editCode && (
                        <button className="btn btn-sm" title="Change this employee's Employee ID" onClick={() => { setCodeFor(e); setCodeForm({ employeeCode: e.employeeCode, reason: '' }); }}>
                          Change ID
                        </button>
                      )}
                      {caps.passwords && e.userId && (
                        <>
                          <button className="btn btn-sm" title="Set a temporary password — they must change it at next sign-in" onClick={() => { setResetFor(e); setResetPassword(''); }}>Reset Password</button>
                          <button className="btn btn-sm" title="Email a single-use set-password link" onClick={() => sendReset(e)}>Send Reset</button>
                        </>
                      )}
                      {/* Everyone who can open this screen may export a person in
                          their scope (the Super Admin is notified of every export). */}
                      <button
                        className="btn btn-sm"
                        title={caps.export ? `Download ${e.name}'s full record as Excel` : `Download ${e.name} in the import-template columns (Excel)`}
                        onClick={() => exportOne(e)}
                        disabled={!!exporting}
                      >
                        {exporting === e.id ? 'Exporting…' : 'Export'}
                      </button>
                      {/* Approve / Reject, for whichever decision is waiting. */}
                      {caps.approve && awaitingDecision && (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            title={requestPending
                              ? 'Approve their request to edit — Unlock appears next'
                              : 'Approve the changes they submitted; the profile locks again'}
                            onClick={() => (requestPending ? approveRequest(e) : approveProfile(e))}
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => { setRejectFor({ ...e, kind: requestPending ? 'request' : 'changes' }); setRejectReason(''); }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {/* ONLY after an edit-access request has been approved. */}
                      {caps.approve && !caps.viewOnly && canUnlock && (
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
              <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>
            )}
          </tbody>
        </table>
      </ScrollTable>
      <Pager page={pagedEmployees} noun="employees" />
      </>)}

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
          title={`${rejectFor.kind === 'request' ? 'Decline edit request' : 'Send back for correction'} — ${rejectFor.name}`}
          onClose={() => { setRejectFor(null); setRejectReason(''); }}
          foot={<>
            <button className="btn" onClick={() => { setRejectFor(null); setRejectReason(''); }}>Cancel</button>
            <button className="btn btn-primary" disabled={!rejectReason.trim()} onClick={submitReject}>Send back</button>
          </>}
        >
          <form onSubmit={submitReject}>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              {rejectFor.kind === 'request'
                ? <>{rejectFor.name} asked for edit access. Declining leaves their profile locked, and the note below is what they see.</>
                : <>{rejectFor.name}&apos;s profile goes back to them to correct and submit again. Their status becomes <b>Change Requested</b>, and the note below is what they see.</>}
            </div>
            <div className="field">
              <label>{rejectFor.kind === 'request' ? 'Why are you declining? *' : 'What needs correcting? *'}</label>
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

      {codeFor && (
        <Modal
          title={`Change Employee ID — ${codeFor.name}`}
          onClose={() => setCodeFor(null)}
          foot={<>
            <button className="btn" onClick={() => setCodeFor(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={!codeDraft || codeDraft === codeFor.employeeCode || !!codeClash} onClick={submitCode}>Change ID</button>
          </>}
        >
          <form onSubmit={submitCode}>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              Current ID <b>{codeFor.employeeCode}</b>. Attendance, leave, payroll, documents and positions follow the
              person, not the ID, so nothing is lost. The change is recorded on their history (old → new).
            </div>
            <div className="field">
              <label>New Employee ID *</label>
              <input autoFocus value={codeForm.employeeCode} onChange={(ev) => setCodeForm({ ...codeForm, employeeCode: ev.target.value })} />
              {codeClash && <span className="small-muted" style={{ color: 'var(--red)' }}>Already used by {codeClash.name}.</span>}
              {!codeClash && codeDraft && codeDraft !== codeFor.employeeCode && !/^TL\d{3,}$/.test(codeDraft) && (
                <span className="small-muted" style={{ color: 'var(--amber)' }}>
                  {codeDraft} does not follow the TL series (TL + at least three digits). You can still save it.
                </span>
              )}
            </div>
            <div className="field">
              <label>Reason (optional)</label>
              <input value={codeForm.reason} onChange={(ev) => setCodeForm({ ...codeForm, reason: ev.target.value })} placeholder="e.g. Matches the HR master sheet" />
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
              <input required type="password" minLength="8" autoComplete="new-password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} /></div>
            <div className="cell-muted" style={{ fontSize: 11.5 }}>
              At least 8 characters with a letter and a number. The password is stored hashed and never shown again —
              pass it to the user yourself; they must change it at their next sign-in. To avoid knowing it at all, use
              Send Password Reset instead.
            </div>
          </form>
        </Modal>
      )}

      {adding && options && (
        <AddEmployeeModal
          form={adding} setForm={setAdding} options={options} employees={employeeIds}
          otp={otp} setOtp={setOtp} emailReady={emailReady} sendOtp={sendOtp} verifyOtp={verifyOtp}
          onClose={() => { setAdding(null); setOtp(EMPTY_OTP); }} onSave={saveNew}
          canDocs={!!caps.edit} error={error}
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
          <EmployeePhoto employeeId={detail.id} name={detail.name} canChange={false} />
          <div className="kv"><span className="k">Email</span><span>{detail.email || '—'}{detail.email && detail.emailVerification && (
            <span className={`status ${detail.emailVerification.verified ? 'approved' : 'priority-high'}`} style={{ marginLeft: 6 }}>
              {detail.emailVerification.verified ? '✓ Verified' : 'Not verified'}
            </span>
          )}</span></div>
          <div className="kv"><span className="k">Mobile</span><span>{detail.phone || '—'}</span></div>
          <div className="kv"><span className="k">Department</span><span>{detail.department || '—'}</span></div>
          <div className="kv"><span className="k">Designation</span><span>{detail.designation || '—'}</span></div>
          <div className="kv"><span className="k">Role</span><span>{detail.role ? atsRoleLabel(detail.role) : '—'}</span></div>
          <div className="kv"><span className="k">Reporting Manager</span><span>{detail.reportingManager || '—'}</span></div>
          <div className="kv"><span className="k">Location</span><span>{detail.location || '—'}</span></div>
          <div className="kv"><span className="k">Joining Date</span><span>{detail.joiningDate || '—'}</span></div>
          <div className="kv"><span className="k">Employment Status</span><span>{detail.employmentStatus}</span></div>
          {/* NOTICE PERIOD — the last working date off the resignation record. */}
          {(ON_NOTICE.includes(detail.employmentStatus) || detail.lastWorkingDate) && (
            <div className="kv">
              <span className="k">Last working date</span>
              <span>
                {detail.lastWorkingDate
                  ? <><b>{lwdLabel(detail.lastWorkingDate)}</b> <span className="small-muted">· {detail.lastWorkingDateSource}</span></>
                  : <span style={{ color: 'var(--red)' }}>Not recorded</span>}
                {caps.lastWorkingDate && (
                  <div className="emgx-lwd-edit">
                    <input type="date" value={lwdDraft} onChange={(ev) => setLwdDraft(ev.target.value)} aria-label="Last working date" />
                    <button type="button" className="btn btn-sm btn-primary" disabled={!lwdDraft || lwdDraft === detail.lastWorkingDate} onClick={saveLwd}>
                      {detail.lastWorkingDate ? 'Change date' : 'Set date'}
                    </button>
                  </div>
                )}
              </span>
            </div>
          )}
          {/* TRANSFER HISTORY — always for a TL / STL / Asst Manager / Manager,
              for anyone else when something is recorded. */}
          <TransferHistory entries={detail.transferHistory} isLead={detail.isLead} />
          {detail.seatHistory?.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Positions held</h4>
              {detail.seatHistory.map((t) => (
                <div className="kv" key={`${t.code}-${t.from}`}>
                  <span className="k">{t.code}</span>
                  <span>
                    {seatMonth(t.from)} – {t.current ? 'today' : seatMonth(t.to)}
                    {t.tookOverFrom && <div className="small-muted">took over from {t.tookOverFrom.name}</div>}
                    {t.handedTo && <div className="small-muted">handed to {t.handedTo.name} ({seatMonth(t.handedTo.from)})</div>}
                  </span>
                </div>
              ))}
            </>
          )}
          <div className="section-label">Login &amp; product access</div>
          {detail.userId ? (
            <>
              <div className="kv"><span className="k">User ID</span><span>{detail.userId}</span></div>
              <div className="kv"><span className="k">HRMS / ATS / Accounts</span>
                <span>{detail.productAccess.hrms} · {detail.productAccess.ats} · {detail.productAccess.accounts}</span></div>
              <div className="kv"><span className="k">Scope</span><span>{detail.scope}</span></div>
              <div className="kv"><span className="k">Login status</span><span>{detail.loginStatus}</span></div>
              <PasswordStatusRows ps={detail.passwordStatus} />
              {caps.passwords && (
                <div style={{ display: 'flex', gap: 8, margin: '8px 0 4px' }}>
                  <button className="btn btn-sm" onClick={() => { setResetFor(detail); setResetPassword(''); }}>Reset Password</button>
                  <button className="btn btn-sm" onClick={() => sendReset(detail)}>Send Password Reset</button>
                </div>
              )}
            </>
          ) : <div className="empty-mini">No login created yet.</div>}
          <div className="section-label">Recent activity</div>
          {detail.activity.length ? detail.activity.map((a, i) => (
            <div className="assign-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={i}>
              <span style={{ fontSize: 12 }}>{a.action}</span>
              <span className="cell-muted" style={{ fontSize: 11.5 }}>{a.date}</span>
            </div>
          )) : <div className="empty-mini">No recorded activity for this employee yet.</div>}
          {/* DOCUMENTS — the same panel as the HR record. Upload / delete appear
              only where the server allows them (HR / Super Admin); a view-only
              Manager or Assistant Manager can open and download. */}
          <div style={{ marginTop: 14 }}>
            <EmployeeDocuments key={detail.id} employeeId={detail.id} />
          </div>
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
// Add Employee's department picker: "All departments" plus one box per
// department. The order ticked is kept — the first is the home department.
function DepartmentChecklist({ all, value, onChange }) {
  const allOn = all.length > 0 && all.every((d) => value.includes(d));
  const toggle = (d, on) => onChange(on ? [...value.filter((x) => x !== d), d] : value.filter((x) => x !== d));
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <label>Departments <i style={{ fontWeight: 400 }}>(tick one or more — the first ticked is their home department)</i></label>
      <div className="dept-checklist">
        <label className="dept-all">
          <input type="checkbox" checked={allOn} onChange={(e) => onChange(e.target.checked ? [...value, ...all.filter((d) => !value.includes(d))] : [])} />
          All departments
        </label>
        {all.map((d) => (
          <label key={d}>
            <input type="checkbox" checked={value.includes(d)} onChange={(e) => toggle(d, e.target.checked)} />
            {d}{value[0] === d && value.length > 1 ? <span className="small-muted"> · home</span> : null}
          </label>
        ))}
      </div>
      {value.length > 0 && (
        <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          Home: <b>{value[0]}</b>{value.length > 1 ? ` · works in ${value.length} departments: ${value.join(', ')}` : ''}
        </div>
      )}
    </div>
  );
}

function AddEmployeeModal({
  form, setForm, options, employees, otp, setOtp, emailReady, sendOtp, verifyOtp, onClose, onSave,
  canDocs = false, error = '',
}) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const [showPassword, setShowPassword] = useState(false);
  // DOCUMENTS ARE PART OF THIS FORM (user, 2026-09-29). The files wait in the
  // browser; Create employee makes the employee FIRST, then uploads each file
  // to them through the ordinary documents API (its rules, its audit). A file
  // that fails is listed with a Retry — the employee exists either way.
  const docsRef = useRef(null);
  const [pendingDocs, setPendingDocs] = useState(0);
  const [docErr, setDocErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [created, setCreated] = useState(null);
  const [docResult, setDocResult] = useState(null);
  const showDocs = canDocs && !!options.documents;

  async function create() {
    setDocErr('');
    const waiting = showDocs && docsRef.current ? docsRef.current.pendingCount() : 0;
    if (waiting) {
      const bad = docsRef.current.validate();
      if (bad) { setDocErr(bad); return; }
    }
    setSaving(true); setTried(true);
    const made = await onSave({ keepOpen: waiting > 0 });
    if (made && waiting) {
      setCreated({ id: made.id, name: made.name, code: made.employeeCode });
      setDocResult(await docsRef.current.uploadAll(made.id));
    }
    setSaving(false);
  }
  // The seats of the chosen department, free ones first so the common case
  // is at the top of the list.
  const deptPositions = (options.positions || [])
    .filter((r) => r.department === form.department)
    .sort((a, b) => (a.holder ? 1 : 0) - (b.holder ? 1 : 0) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const vacantCount = deptPositions.filter((r) => !r.holder).length;
  // TEAMS ARE AN EDUCATION THING. Rather than naming Education in the code,
  // this asks the department master which departments actually have teams —
  // so the field appears for exactly those, and adding or removing a team in
  // Administration is the only thing needed to change that.
  const deptTeams = ((options.departmentTree || []).find((d) => d.name === form.department) || {}).teams || [];

  const chosen = (options.designations || []).find((d) => d.designation === form.designation);
  const access = chosen
    ? {
      hrms: chosen.products.hrms ? 'Yes' : 'No Access',
      ats: chosen.products.ats ? (chosen.atsRole || 'Yes') : 'No Access',
      accounts: chosen.products.accounts ? 'Yes' : 'No Access',
    }
    : { hrms: '—', ats: '—', accounts: '—' };
  const scope = form.department ? `${form.department}${form.team ? ` · team ${form.team}` : ''}` : '—';
  // NO OTP GATE. HR types the address and the password and presses Create;
  // the welcome mail goes out on its own. Nothing here waits on a code.
  // No Designation field any more (user, 2026-09-29): the server takes it from
  // the chosen Role (or "Employee"); HR can change it later on Edit.
  const canSave = form.name.trim() && form.email.trim() && form.department;

  return (
    <Modal
      title="Add Employee — creates their employee record and login together"
      size="xwide"
      bodyStyle={{ padding: '20px 26px' }}
      onClose={onClose}
      foot={created ? (
        <button className="btn btn-primary" disabled={saving} onClick={onClose}>{saving ? 'Uploading documents…' : 'Done'}</button>
      ) : <>
        <button className="btn btn-primary" disabled={!canSave || saving} onClick={create}>
          {saving ? 'Creating…' : `Create employee${pendingDocs ? ` + ${pendingDocs} document${pendingDocs === 1 ? '' : 's'}` : ''}`}
        </button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </>}
    >
      {created && (
        <div className={`notice${docResult && docResult.failed ? ' amber' : ''}`}>
          <span>
            <b>{created.name}{created.code ? ` (${created.code})` : ''}</b> created — employee record and login.{' '}
            {!docResult ? 'Uploading their documents…'
              : docResult.failed
                ? `${docResult.ok} of ${docResult.total} documents uploaded; ${docResult.failed} failed — the reason is on each file below. Retry it, or add it later on their Edit form.`
                : `All ${docResult.total} document${docResult.total === 1 ? '' : 's'} uploaded.`}
          </span>
        </div>
      )}
      {!created && tried && error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {!created && (<>
      {/* SIX FIELDS, AND NO MORE.
          "oka emp create cheyyadaniki start just small fields ey enter cheyyali
          HR" — HR opens the account, the credentials go out, and the employee
          fills in the rest of their own profile and submits it for review.
          Date of birth, gender, team, reporting line, mobile, location, joining
          date, employment type and status are NOT gone: they are on the
          employee record, which is where the employee now enters them. */}
      {/* Bigger form (user, 2026-09-29): wide modal, fields spread across up to
          three columns and fall back to one on a phone. */}
      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '14px 20px' }}>
        <div className="field">
          <label>Employee ID <i style={{ fontWeight: 400 }}>(next in series — auto if blank)</i></label>
          <input
            value={form.employeeId}
            onChange={(e) => set({ employeeId: e.target.value })}
            placeholder={`e.g. ${options.nextEmployeeCode || 'TL517'}`}
          />
          {form.employeeId && form.employeeId.trim() !== (form.suggestedId || '') && !/^TL\d{3,}$/.test(form.employeeId.trim()) && (
            <span className="small-muted" style={{ color: 'var(--amber)' }}>
              {form.employeeId.trim()} does not follow the TL series (e.g. {form.suggestedId || 'TL517'}).
            </span>
          )}
          {employees.length > 0 && form.employeeId.trim() && form.employeeId.trim() !== (form.suggestedId || '')
            && employees.some((x) => (x.code || '').toLowerCase() === form.employeeId.trim().toLowerCase()) && (
            <span className="small-muted" style={{ color: 'var(--red)' }}>That Employee ID is already in use.</span>
          )}
        </div>
        <div className="field">
          <label>Full name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>

        {/* DEPARTMENTS — a checklist, with "All departments" on top. A TL can
            be given two, an STL three, anyone all of them. The FIRST one ticked
            is the home department (seat, team, employee record); every ticked
            one becomes the login's data scope. Changing the home department
            clears the seat: a seat belongs to one department. */}
        <DepartmentChecklist
          all={options.departments}
          value={form.departments && form.departments.length ? form.departments : (form.department ? [form.department] : [])}
          onChange={(list) => set({
            departments: list,
            department: list[0] || '',
            ...(list[0] !== form.department ? { position: '', team: '' } : {}),
          })}
        />

        {/* THE SEAT — MED-1, MED-2, EDU BDE 1.

            Offered only once a department is chosen, and then only that
            department's seats, because "MED-1" is not a choice that means
            anything under Education. Creatable, like Department beside it:
            typing MED-6 when the company opens a sixth medical desk creates
            the seat on save, so nobody has to go to Administration first.

            A seat someone already holds is listed and labelled rather than
            hidden — a missing MED-3 reads as "no such seat", which is a
            different fact from "taken". The server refuses it either way. */}
        <div className="field">
          <label>Position <i style={{ fontWeight: 400 }}>(optional — the seat, not the person)</i></label>
          <Combo
            creatable
            disabled={!form.department}
            value={form.position}
            onChange={(e) => set({ position: e.target.value })}
          >
            <option value="">
              {form.department ? 'No seat' : 'Choose a department first'}
            </option>
            {deptPositions.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code}
                {r.name ? ` · ${r.name}` : ''}
                {r.holder ? ` · held by ${r.holder}` : ''}
              </option>
            ))}
          </Combo>
          {form.department && (
            <span className="small-muted">
              {deptPositions.length
                ? `${vacantCount} of ${deptPositions.length} free in ${form.department}. Type a new code to add one.`
                : `No seats set up for ${form.department} yet — type one (e.g. MED-1) to create it.`}
            </span>
          )}
        </div>

        {/* TEAM — only for a department that HAS teams, which today means
            Education (Team-A / Team-B) and nothing else. Showing an empty
            Team picker on Medical would invite somebody to invent one.

            It sets the employee record AND the login's team scope, which is
            what a team lead is then held to. */}
        {deptTeams.length > 0 && (
          <div className="field">
            <label>Team</label>
            <Combo value={form.team} onChange={(e) => set({ team: e.target.value })}>
              <option value="">No team</option>
              {deptTeams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Combo>
          </div>
        )}
        {/* NO DESIGNATION FIELD (user, 2026-09-29). The server sets it from
            the Role below (or "Employee"); HR changes it later on Edit. */}

        {/* ROLE — every ACTIVE role from Role Catalog (system + custom), loaded
            from the API; a role added there appears here with no code change.
            It sets the product role(s) it is for on the new login, so its
            permissions apply from the first request. Empty = the
            designation's own roles. */}
        <div className="field">
          <label>Role</label>
          <Combo value={form.roleCode || ''} onChange={(e) => set({ roleCode: e.target.value })}>
            <option value="">Employee (HRMS only)</option>
            {(options.roleCatalog || []).map((r) => (
              <option key={r.code} value={r.code}>{r.name}{r.isSystem ? '' : ' (custom)'}</option>
            ))}
          </Combo>
          {form.roleCode && (() => {
            const r = (options.roleCatalog || []).find((x) => x.code === form.roleCode);
            const prods = r && !r.isSystem
              ? ['hrms', 'ats', 'accounts'].filter((p) => r.products && r.products[p]).map((p) => ({ hrms: 'HRMS', ats: 'ATS', accounts: 'Accounts' }[p]))
              : [];
            return r ? (
              <span className="small-muted">
                {r.isSystem ? `${r.name} for the products it works in.` : `Sets the ${prods.join(' + ') || '—'} role to ${r.name}; the other products follow the designation.`}
                {r.description ? ` ${r.description}` : ''}
              </span>
            ) : null;
          })()}
        </div>

        {/* The address the welcome mail goes to, and the one they sign in
            with. It is checked for shape and for uniqueness on the server;
            it is NOT proved by a code any more, so a typo means a mail that
            lands nowhere — which the result panel reports. */}
        <div className="field">
          <label>Email</label>
          <input
            type="email"
            /* Not the signing-in user's address — see the note on the
               password below. */
            autoComplete="off"
            name="new-employee-email"
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
          {/* Still worth saying when there is no channel at all: the
              employee is created either way, but nothing will reach them. */}
          {!emailReady && (
            <span className="small-muted">
              No SMTP provider is configured — {options.email?.reason} The employee will be
              created, but no welcome mail can be sent.
            </span>
          )}
        </div>

        <div className="field">
          <label>Password <i style={{ fontWeight: 400 }}>(for their login)</i></label>
          <div className="field-with-btn">
            <input
              type={showPassword ? 'text' : 'password'}
              /* THE PASSWORD BEING SET FOR SOMEBODY ELSE, not the one this
                 browser has saved for the person signed in. Chrome ignores
                 autoComplete="off" on password inputs; "new-password" is
                 the value it honours, and it is the truthful one. */
              autoComplete="new-password"
              name="new-employee-password"
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder="leave empty to email a set-password link"
            />
            <button type="button" className="btn btn-sm" onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
      </div>

      <div className="small-muted" style={{ marginTop: 4 }}>
        Creates their employee record and login account together — they can sign in right away to fill in the
        rest of their profile.
      </div>

      {/* What this person will actually be able to do, shown before saving. */}
      {chosen && (
        <div className="notice" style={{ marginTop: 10 }}>
          <span>
            Login role → <b>{atsRoleLabel(chosen.atsRole || 'EMPLOYEE')}</b>
            &nbsp;·&nbsp; HRMS → {access.hrms}&nbsp;·&nbsp; ATS → {access.ats}
            &nbsp;·&nbsp; Accounts → {access.accounts}&nbsp;·&nbsp; Scope: {scope}.
            All derived from the department and the designation.
          </span>
        </div>
      )}
      </>)}

      {/* DOCUMENTS — inside the form, below the fields; the same section as
          the Edit form and My Profile. Only for a caller who may upload to an
          employee (Employee Management edit); the server re-checks each file. */}
      {showDocs && (
        <EmployeeDocuments
          ref={docsRef}
          embedded
          meta={options.documents}
          onChange={(n) => { setPendingDocs(n); setDocErr(''); }}
          intro={created ? null : 'Attach what you have now — several files per type is fine. They upload to the new employee when you press Create employee; more can be added later.'}
        />
      )}
      {docErr && <div className="error-text" style={{ marginTop: 8 }}>{docErr}</div>}
    </Modal>
  );
}

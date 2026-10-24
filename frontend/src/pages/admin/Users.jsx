import { useEffect, useMemo, useState } from 'react';
import GeneratePassword from '../../components/GeneratePassword.jsx';
import { PasswordBadge } from '../../components/PasswordStatus.jsx';
import { HR_STATUSES, EXIT_EMPLOYMENT, hrStatusOf } from '../../hrStatus';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { ATS_ROLE_LABELS, atsRoleLabel, registerRoleLabels } from '../../atsVocab';
import { useMasters, withCurrent } from '../../utils/masters';
import Combo from '../../components/Combo.jsx';
import ScopeChecklist from '../../components/ScopeChecklist.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { ViewAsButton } from '../../components/ViewAs.jsx';
import ActAsHistory from '../../components/ActAsHistory.jsx';
import { MultiLoginBanner, ExistingLogins, CreatedLogin } from './LoginAccounts.jsx';
import { clientLabel } from '../../utils/clientLocation.js'; // "Name - Location" for same-name clients (2026-10-22)

// Users / Employee Management (the prototype's usersView, line 9893).
//
// One employee = one user = one login. Granting access never creates a second
// identity: the "Create login" form picks an employee who has none yet and
// attaches a login to that same record.
//
// SEPARATE LOGINS ON ONE EMAIL (founder, 2026-10-21): an Admin may ALSO add another, separate login for the same person - same email, same
// Employee record, but its own password (the person sets it from an emailed link) and exactly the modules ticked here. People sign in
// with their email only; the Users table tells the logins on one email apart by role + department. The form shows the logins already on that email first, and asks for a tick before it makes another.
//
// ROLE MODEL — ONE LOGIN, THREE INDEPENDENT PRODUCT ROLES.
//
//   USER
//    ├── HRMS Role      → Employee
//    ├── ATS Role       → Recruiter
//    └── Accounts Role  → None
//
// Each product carries its OWN role on the same account, and the permission
// engine resolves the role for the product being asked about. Being an
// Employee in HRMS does not deny Recruiter actions in ATS, and an Accounts
// role of "No Access" refuses Accounts outright however senior the other two
// are. All three selects below are REAL: changing one changes what the API
// itself allows, not just what this screen draws.
//
// The row reads the way the model does: the EMPLOYEE first (ID, name, email,
// mobile), then HRMS (role + scope), then ATS (role + department + STL + TL +
// clients + requirements), then Accounts (role), then status and last login.

const ROLES = Object.keys(ATS_ROLE_LABELS);
const STATUSES = ['Active', 'Inactive', 'Suspended'];
// The login's own status (the form) is Active / Inactive / Suspended; the
// FILTER uses the five HRMS statuses, which also know who is on notice or has left.
const hasExited = (u) => EXIT_EMPLOYMENT.includes(u.employmentStatus);

// The role vocabulary each product offers. It is the SAME catalog for all
// three — that is the point of the product dimension: one role name can mean
// different things in ATS and in HRMS, so the name is not reserved to one
// product. '' is stored as 'NONE', an explicit "no role in this product",
// which the engine refuses outright.
//
// ATS is the one exception: ACCOUNTANT and CANDIDATE are not ATS working
// roles, and offering them would let an admin type a role the ATS matrix has
// nothing to say about.
const PRODUCT_WORK_ROLES = {
  hrms: ['', ...ROLES],
  // ACCOUNTANT is an ATS role now too — the read-only billing view of Jobs /
  // Requirements and Clients (role specs 2026-09-29).
  ats: ['', ...ROLES, 'CANDIDATE'],
  accounts: ['', ...ROLES],
};

// A stored 'NONE' and an absent role mean the same thing to this screen: the
// product select shows "No Access".
const shownRole = (value) => (value && value !== 'NONE' ? value : '');

const EMPTY_FORM = {
  // sendActivation: the person chooses the password from an emailed link (recommended). additional: another separate login on an email
  // that already has one; pHrms / pAts / pAccounts: the role in each product for such a login ('' = No Access).
  sendActivation: true, additional: false, pHrms: '', pAts: '', pAccounts: '',
  employeeId: '', name: '', email: '', username: '', password: '',
  role: 'EMPLOYEE', atsDepartment: '', branch: '', team: '', status: 'Active', clientId: '',
  hrmsAccess: true, atsAccess: false, accountsAccess: false, atsRole: '',
  atsScopeDepartments: '', atsScopeTeams: '',
};

// ADD EMPLOYEE and EDIT SCOPE have MOVED to HRMS → Employee Management
// (frontend/src/pages/Employees.jsx). Both were duplicated here; this screen
// links to the one implementation of each rather than keeping a copy, so the
// email one-time code, the auto Employee ID, the designation-derived role and
// the scope checklists all exist exactly once in the app.

function statusClass(status) {
  if (status === 'Active') return 'priority-low';
  if (status === 'Suspended') return 'priority-high';
  return 'priority-medium';
}

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [freeEmployees, setFreeEmployees] = useState([]);
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  // "Get reset link": the one-time link, shown ON SCREEN to hand over (never a password).
  const [resetLink, setResetLink] = useState(null);
  const [copied, setCopied] = useState(false);
  // The bell / email "Block this login" button opens this screen as /admin/users?block=<id>.
  const [params, setParams] = useSearchParams();
  const blockId = params.get('block');
  // What POST /employees/:id/send-credentials hands back: the one-time
  // sign-in link. Shown once, never stored — the same contract Employee
  // Management had before this moved here.
  const [credentials, setCredentials] = useState(null);
  // Separate logins on one email: the ON/OFF status, every employee for the picker, the logins already on the typed email, and the
  // "login created" card.
  const [mlStatus, setMlStatus] = useState(null);
  const [employeePicker, setEmployeePicker] = useState([]);
  const [lookup, setLookup] = useState(null);
  const [created, setCreated] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [revokeAsk, setRevokeAsk] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  // Branch / team / scope are read-only text in the table (as in the prototype);
  // this modal is where main's inline editing of them moved to.
  const [editing, setEditing] = useState(null);
  const [departments, setDepartments] = useState([]);
  // ROLES ARE DATA: custom roles from Role Catalog join the product pickers
  // and the filter without a code change (GET /admin/roles).
  const [roleCatalog, setRoleCatalog] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Super Admin only: accounts that still use a starting (seed / demo) password. Names only.
  const [startingPw, setStartingPw] = useState(null);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  function load() {
    api.get('/admin/users').then((res) => setUsers(res.data)).catch(() => setError('Could not load users.'));
    api.get('/admin/users/starting-password').then((res) => setStartingPw(res.data)).catch(() => setStartingPw(null));
    api.get('/admin/users/employees-without-login').then((res) => setFreeEmployees(res.data)).catch(() => setFreeEmployees([]));
    api.get('/admin/logins/status').then((res) => setMlStatus(res.data)).catch(() => setMlStatus(null));
    api.get('/admin/logins/employees').then((res) => setEmployeePicker(res.data)).catch(() => setEmployeePicker([]));
  }
  // THE LIVE MASTERS (utils/masters.js): departments, teams, branches and the
  // role list. A role added on Role Catalog or a department / team added on
  // Departments & Teams changes masters.version, which re-reads the two lists
  // below — no reload, no hard-coded array.
  const masters = useMasters();
  useEffect(() => {
    load();
    // Only id and name are used here: the light pick list, not the 1.7 MB client table.
    api.get('/clients/picker', { params: { limit: 1000 } }).then((res) => setClients(res.data.rows || [])).catch(() => setClients([]));
  }, []);
  useEffect(() => {
    api.get('/admin/departments').then((res) => setDepartments(res.data)).catch(() => setDepartments([]));
    api.get('/admin/roles', { params: { all: '1' } })
      .then((res) => { registerRoleLabels(res.data); setRoleCatalog(res.data); })
      .catch(() => setRoleCatalog([]));
  }, [masters?.version]);

  // The logins already on the typed email (or of the chosen employee): shown to the Admin before another one is made.
  useEffect(() => {
    if (!showForm) return undefined;
    const em = form.email.trim();
    const validEmail = /^\S+@\S+\.\S{2,}$/.test(em);
    if (!validEmail && !form.employeeId) { setLookup(null); return undefined; }
    const t = setTimeout(() => {
      api.get('/admin/logins/by-email', { params: { email: validEmail ? em : '', employeeId: form.employeeId || '' } })
        .then((res) => setLookup(res.data)).catch(() => setLookup(null));
    }, 350);
    return () => clearTimeout(t);
  }, [form.email, form.employeeId, showForm]);

  // The department master already arrives with its teams nested, so both
  // checkbox lists come off the one fetch rather than a second round trip.
  const departmentOptions = useMemo(
    () => departments.map((d) => d.name).filter(Boolean).sort(),
    [departments],
  );
  const teamOptions = useMemo(
    () => [...new Set(departments.flatMap((d) => (d.teams || []).map((t) => t.name)))].filter(Boolean).sort(),
    [departments],
  );

  // A product's picker: the system roles, plus every ACTIVE custom role that
  // fills that product. A login still holding an inactive one keeps it listed.
  const customRoles = roleCatalog.filter((r) => !r.isSystem);
  // System roles live in the Role table too (e.g. HR); any the static list
  // above does not carry are added from the catalog, never typed here.
  const liveSystemRoles = [...roleCatalog, ...(masters?.roles || [])]
    .filter((r) => r.isSystem && !r.external && !['CLIENT', 'CANDIDATE'].includes(r.code)).map((r) => r.code)
    .filter((c, i, all) => !ROLES.includes(c) && all.indexOf(c) === i);
  const accountRoles = (current) => withCurrent([...ROLES, ...liveSystemRoles], current);
  // Department / branch / team choices: the live masters, falling back to the
  // department master this screen reads anyway until /masters answers.
  const deptChoices = masters ? masters.departments : departments.map((d) => d.name).filter(Boolean).sort();

  // THE FILTER STANDARD (components/ui/ListFilters.jsx): Search · Role ·
  // Status · Department on screen; Product access · Login status ·
  // Designation under More Filters; chips, Clear All, Sort, paging. The list
  // is loaded whole (Administration only), so it is filtered here.
  const roleOptions = [
    ...[...ROLES, ...liveSystemRoles].map((r) => ({ value: r, label: atsRoleLabel(r) })),
    ...customRoles.map((r) => ({ value: r.code, label: `${r.name}${r.active ? '' : ' (inactive)'}` })),
  ];
  const lf = useListFilters(users, [
    { key: 'q', type: 'search', placeholder: 'Search name, email, employee ID…',
      get: (u) => `${u.name} ${u.email} ${u.employeeId || ''} ${u.username || ''}` },
    { key: 'role', label: 'Role', allLabel: 'All roles', options: roleOptions, primary: true,
      match: (u, v) => u.role === v || Object.values(u.productRoles || {}).includes(v) },
    { key: 'status', label: 'Status', allLabel: 'All statuses', options: HR_STATUSES, primary: true,
      match: (u, v) => hrStatusOf(u.employmentStatus, u.status) === v },
    { key: 'department', label: 'Department', allLabel: 'All departments', primary: true, get: (u) => u.department },
    { key: 'product', label: 'Product access', allLabel: 'Any product',
      options: [{ value: 'hrms', label: 'HRMS' }, { value: 'ats', label: 'ATS' }, { value: 'accounts', label: 'Accounts' }],
      match: (u, v) => !!(u.products && u.products[v]) },
    { key: 'login', label: 'Login status', allLabel: 'All login statuses', options: STATUSES, get: (u) => u.status },
    { key: 'designation', label: 'Designation', allLabel: 'All designations', get: (u) => u.designation },
    { key: 'pw', label: 'Password', allLabel: 'Any password state',
      options: [{ value: 'never', label: 'Never changed' }, { value: 'changed', label: 'Changed' }],
      match: (u, v) => (v === 'never' ? !u.passwordStatus?.passwordChangedAt : !!u.passwordStatus?.passwordChangedAt) },
  ], {
    sorts: [
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
      { key: 'code', label: 'Employee ID', cmp: (a, b) => String(a.employeeId || '~').localeCompare(String(b.employeeId || '~'), undefined, { numeric: true }) },
      { key: 'new', label: 'Newest first', cmp: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) },
      { key: 'dept', label: 'Department', cmp: (a, b) => String(a.department || '~').localeCompare(String(b.department || '~')) || String(a.name || '').localeCompare(String(b.name || '')) },
    ],
  });
  const rows = lf.rows;
  const page = usePaged(rows);
  const productOptions = (product, current) => {
    const list = [...PRODUCT_WORK_ROLES[product],
      ...(product === 'ats' ? [] : liveSystemRoles.filter((c) => !PRODUCT_WORK_ROLES[product].includes(c))),
      ...customRoles.filter((r) => r.active && r.products && r.products[product]).map((r) => r.code)];
    if (current && !list.includes(current)) list.push(current);
    return list;
  };

  async function run(fn, successMessage) {
    setError(''); setNotice('');
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      load();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
      return false;
    }
  }

  // Set ONE product's role. Choosing a role grants that product; choosing
  // "No Access" revokes it. The other two products are untouched — that is
  // the whole point of the three-role model.
  const PRODUCT_ACCESS_KEY = { hrms: 'hrmsAccess', ats: 'atsAccess', accounts: 'accountsAccess' };
  const PRODUCT_ROLE_KEY = { hrms: 'hrmsRole', ats: 'atsRole', accounts: 'accountsRole' };

  function setProductRole(u, product, role) {
    run(() => api.put(`/admin/users/${u.id}`, {
      [PRODUCT_ROLE_KEY[product]]: role || 'NONE',
      [PRODUCT_ACCESS_KEY[product]]: !!role,
    }),
    `${u.name} — ${product.toUpperCase()} role: ${role ? atsRoleLabel(role) : 'No Access'} (their other products are unchanged).`);
  }

  // Mails ONE login (this row, by its own id) a fresh single-use link to choose its password. The mail names its role and department; a
  // sibling login on the same email is never touched. The Admin never sees a password.
  async function sendSignIn(u) {
    setError(''); setNotice(''); setCredentials(null);
    try {
      const res = await api.post(`/admin/logins/${u.id}/send-activation`);
      setCredentials({ ...res.data, name: u.name });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not issue sign-in details.');
    }
  }

  // Switch ONE login off and end its open sessions. The others on the same email carry on.
  async function revokeLogin(u) {
    setRevokeAsk(null);
    await run(() => api.post(`/admin/logins/${u.id}/revoke`), `${u.name} (${u.roleLabel || 'this login'}) is switched off and signed out. Their other logins are not touched.`);
  }

  async function switchMultiLoginOn() {
    setSwitching(true); setError(''); setNotice('');
    try {
      const res = await api.post('/admin/logins/upgrade');
      setNotice(res.data.alreadyDone ? 'Several logins on one email was already ON.' : 'Several logins on one email is ON. A backup copy was made first.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not switch it on.');
    } finally {
      setSwitching(false);
    }
  }

  async function saveEditing() {
    const ok = await run(
      () => api.put(`/admin/users/${editing.id}`, {
        role: editing.role,
        branch: editing.branch,
        team: editing.team,
        atsDepartment: editing.atsDepartment || null,
        atsScopeDepartments: editing.atsScopeDepartments || null,
        atsScopeTeams: editing.atsScopeTeams || null,
        atsScopeClients: editing.atsScopeClients || null,
      }),
      `${editing.name} updated.`,
    );
    if (ok) setEditing(null);
  }

  // EDIT SCOPE and ADD EMPLOYEE used to be implemented here. Both now live
  // on HRMS → Employee Management, which is the screen that owns the employee
  // master; the Scope column below links to it rather than re-implementing
  // either one.

  function toggleStatus(u) {
    run(() => api.post(`/admin/users/${u.id}/toggle-status`),
      `${u.name} — login ${u.status === 'Active' ? 'disabled' : 'enabled'}.`);
  }

  async function getResetLink(u) {
    setError(''); setNotice(''); setResetLink(null); setCopied(false);
    try {
      const res = await api.post(`/admin/users/${u.id}/reset-link`);
      setResetLink(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not make a reset link.');
    }
  }

  const neverChanged = users.filter((u) => u.status === 'Active' && !u.passwordStatus?.passwordChangedAt).length;
  const blockUser = blockId ? users.find((u) => u.id === blockId) : null;

  async function submitReset(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/admin/users/${resetFor.id}/reset-password`, { password: resetPassword }),
      `Password reset for ${resetFor.name}. Share it with them out of band — it is never shown again.`);
    if (ok) { setResetFor(null); setResetPassword(''); }
  }

  // Picking the employee fills their details; this form only decides what they
  // can reach — the prototype's auFill().
  function pickEmployee(id) {
    const emp = employeePicker.find((e) => e.id === id) || freeEmployees.find((e) => e.id === id);
    if (!emp) { set({ employeeId: '', additional: false }); return; }
    set({
      employeeId: id,
      name: emp.name,
      email: emp.email || form.email || '',
      username: emp.email || emp.name.toLowerCase().replace(/[^a-z]+/g, '.'),
      atsDepartment: emp.department || '',
      branch: emp.branch || emp.location || '',
      team: emp.team || '',
      // an employee who already has a login can only get a SEPARATE one (ticked below, after the panel shows what exists)
      additional: (emp.loginCount || 0) > 0 ? form.additional : false,
    });
  }

  async function createUser(e) {
    e.preventDefault();
    setError(''); setNotice('');
    const body = { ...form, clientId: form.role === 'CLIENT' ? form.clientId : undefined };
    ['pHrms', 'pAts', 'pAccounts', 'additional', 'sendActivation'].forEach((k) => delete body[k]);
    if (form.additional) {
      // A separate login gets exactly what is chosen here; the person sets the password from an emailed link.
      body.additionalLogin = true;
      delete body.password;
      [['hrms', form.pHrms], ['ats', form.pAts], ['accounts', form.pAccounts]].forEach(([p, role]) => {
        body[`${p}Access`] = !!role;
        body[`${p}Role`] = role || 'NONE';
      });
    } else if (form.sendActivation) {
      body.sendActivation = true;
      delete body.password;
    }
    try {
      const res = await api.post('/admin/users', body);
      setCreated({ ...res.data, email: body.email });
      setForm(EMPTY_FORM); setShowForm(false); setLookup(null);
      load();
    } catch (err) {
      const d = err.response?.data;
      setError(d?.error || 'That change could not be saved.');
      // The email already has logins and the tick was missing: show them so the Admin can decide.
      if (d?.code === 'EMAIL_HAS_LOGINS' && d.existing) setLookup((cur) => ({ ...(cur || {}), count: d.existing.length, sameEmail: d.existing.length, accounts: d.existing, multiLoginOn: cur ? cur.multiLoginOn : true }));
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="page-sub">
            Each login has its own password. HRMS, ATS and Accounts roles are independent on a login.
            The same email can have more than one separate login when the person needs it.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Add Employee lives on Employee Management — one implementation,
              with the email one-time code and the designation-derived role. */}
          <Link className="btn btn-primary" to="/employees">Add Employee →</Link>
          <button className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'Add User'}
          </button>
        </div>
      </div>

      <MultiLoginBanner status={mlStatus} isSuper={me?.role === 'SUPER_ADMIN'} onSwitchOn={switchMultiLoginOn} busy={switching} />
      <CreatedLogin info={created} onDone={() => setCreated(null)} />
      {startingPw && startingPw.count > 0 && (
        <div className="notice amber" style={{ display: 'block', marginBottom: 12 }} data-testid="starting-password-banner">
          <b>{startingPw.count} {startingPw.count === 1 ? 'account still uses' : 'accounts still use'} a starting password.</b>{' '}
          They must choose their own at the next sign-in: {startingPw.accounts.slice(0, 12).map((a) => a.name).join(', ')}{startingPw.count > 12 ? ' and more' : ''}.
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section" style={{ marginBottom: 14 }}>{notice}</div>}
      {/* The one-time sign-in link, shown once. Moved here with the button. */}
      {credentials && (
        <div className="card section" style={{ borderColor: credentials.sent ? undefined : 'var(--warn)' }}>
          <h3 style={{ fontSize: 13 }}>Sign-in link for {credentials.name}{credentials.role ? ` · ${credentials.role}` : ''}</h3>
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

      {/* "Block this login": the button in the password-changed alert lands here. */}
      {blockUser && (
        <div className="card section" style={{ borderColor: 'var(--warn)' }} data-testid="block-banner">
          <h3 style={{ fontSize: 14, marginTop: 0 }}>{blockUser.name} changed their password</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            If this was not them, block the login now. They can be switched on again later.
          </div>
          {blockUser.status === 'Active' ? (
            <button className="btn btn-primary" disabled={blockUser.id === me?.id}
              onClick={async () => { const ok = await run(() => api.post(`/admin/users/${blockUser.id}/toggle-status`), `${blockUser.name}'s login is blocked.`); if (ok) setParams({}); }}>
              Block this login
            </button>
          ) : <span className="status rejected">This login is already blocked</span>}{' '}
          <button className="btn" onClick={() => setParams({})}>It was them - close</button>
        </div>
      )}
      {resetLink && (
        <div className="card section" data-testid="reset-link-card">
          <h3 style={{ fontSize: 14, marginTop: 0 }}>Reset link for {resetLink.name}</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Give this link to {resetLink.name} yourself. It works once and stops working in {resetLink.minutes} minutes
            (at {new Date(resetLink.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}).
            They choose their own password - you never see it. This link is shown only now.
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', background: 'var(--bg-soft, #f3f4f6)', padding: 8, borderRadius: 6 }}>{resetLink.link}</div>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }}
            onClick={() => { navigator.clipboard?.writeText(resetLink.link).then(() => setCopied(true)).catch(() => {}); }}>
            {copied ? 'Copied' : 'Copy link'}
          </button>{' '}
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setResetLink(null)}>Done</button>
        </div>
      )}

      {neverChanged > 0 && (
        <div className="small-muted" style={{ margin: '0 0 8px' }}>
          {neverChanged} active login{neverChanged === 1 ? ' has' : 's have'} never changed the first password.{' '}
          <button type="button" className="link-btn" style={{ background: 'none', border: 0, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
            onClick={() => lf.setValue('pw', 'never')}>Show them</button>
        </div>
      )}

      {showForm && (
        <form className="card section" onSubmit={createUser}>
          <h3>Create a login</h3>
          <div className="small-muted" style={{ marginBottom: 12 }}>
            Pick the employee (type to search). A new login is linked to that same employee, so no second employee record is made.
            If the person already has a login, you can add another separate one.
          </div>
          <div className="grid-2">
            <label className="field"><span>Employee</span>
              <Combo value={form.employeeId} onChange={(e) => pickEmployee(e.target.value)}>
                <option value="">— standalone login (no employee record) —</option>
                {(employeePicker.length ? employeePicker : freeEmployees).map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name} — {emp.employeeCode}{emp.loginCount ? ` · has ${emp.loginCount} login${emp.loginCount === 1 ? '' : 's'}` : ''}</option>
                ))}
              </Combo></label>
            <label className="field"><span>Full name</span>
              <input required value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="field"><span>Email</span>
              <input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></label>
            <label className="field"><span>Username</span>
              <input value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder="filled from the email" /></label>
            <label className="field"><span>Password</span>
              {(form.additional || form.sendActivation) ? (
                <span className="small-muted" style={{ fontWeight: 400, display: 'block', padding: '6px 0' }}>
                  The person chooses it from a link we email. You never see it.
                </span>
              ) : (
                <input type="password" minLength="6" required value={form.password} onChange={(e) => set({ password: e.target.value })} />
              )}
              {!form.additional && (
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, marginTop: 4 }}>
                  <input type="checkbox" checked={form.sendActivation} onChange={(e) => set({ sendActivation: e.target.checked })} style={{ width: 'auto' }} />
                  <span className="small-muted">Email a link so the person chooses the password (recommended)</span>
                </label>
              )}
            </label>
            <label className="field"><span>Role</span>
              <Combo value={form.role} onChange={(e) => set({ role: e.target.value })}>
                {accountRoles(form.role).map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
              </Combo></label>
            <label className="field"><span>Department scope</span>
              <Combo creatable value={form.atsDepartment} onChange={(e) => set({ atsDepartment: e.target.value })}>
                <option value="">All departments</option>
                {withCurrent(deptChoices, form.atsDepartment).map((d) => <option key={d}>{d}</option>)}
              </Combo></label>
            <label className="field"><span>Branch</span>
              <Combo creatable value={form.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="Select or type a branch">
                <option value="">—</option>
                {withCurrent(masters?.branches, form.branch).map((b) => <option key={b}>{b}</option>)}
              </Combo></label>
            <label className="field"><span>Team</span>
              <Combo creatable value={form.team} onChange={(e) => set({ team: e.target.value })} placeholder="e.g. Section A">
                <option value="">—</option>
                {withCurrent(masters?.teamNames, form.team).map((t) => <option key={t}>{t}</option>)}
              </Combo></label>
            <label className="field"><span>Status</span>
              <Combo value={form.status} onChange={(e) => set({ status: e.target.value })}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </Combo></label>
            {form.role === 'CLIENT' && (
              <label className="field"><span>Client</span>
                <Combo required value={form.clientId} onChange={(e) => set({ clientId: e.target.value })}>
                  <option value="">—</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
                </Combo>
                <span className="small-muted">A Client login sees only this company.</span></label>
            )}
          </div>
          <ExistingLogins
            lookup={lookup}
            checked={form.additional}
            onCheck={(v) => set({ additional: v })}
            onPickEmployee={pickEmployee}
            hasEmployee={!!form.employeeId}
          />
          {form.additional && (
            <div className="card section" style={{ marginBottom: 12 }} data-testid="separate-login-access">
              <h4 style={{ fontSize: 13, margin: '0 0 4px' }}>What can this separate login open?</h4>
              <div className="small-muted" style={{ marginBottom: 8 }}>
                Only what you choose here. Nothing is copied from the person's other logins. Leave a product on No Access to keep it closed.
              </div>
              <div className="grid-2">
                {[['pHrms', 'hrms', 'HRMS role'], ['pAts', 'ats', 'ATS role'], ['pAccounts', 'accounts', 'Accounts role']].map(([key, product, label]) => (
                  <label className="field" key={key}><span>{label}</span>
                    <Combo value={form[key]} onChange={(e) => set({ [key]: e.target.value })}>
                      {productOptions(product, form[key]).map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                    </Combo></label>
                ))}
              </div>
            </div>
          )}
          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={form.additional && ((lookup && lookup.multiLoginOn === false) || (!form.pHrms && !form.pAts && !form.pAccounts && !['SUPER_ADMIN', 'ADMIN'].includes(form.role)))}
          >
            {form.additional ? 'Create separate login' : 'Grant access'}
          </button>
        </form>
      )}

      {resetFor && (
        <form className="card section" onSubmit={submitReset}>
          <h3>Reset password — {resetFor.name}{resetFor.roleLabel ? ` · ${resetFor.roleLabel}` : ''}</h3>
          <div className="grid-2">
            <label className="field"><span>New password</span>
              <input required type="password" minLength="8" autoComplete="new-password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} /></label>
            <GeneratePassword onGenerate={setResetPassword} />
          </div>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            At least 8 characters with a letter and a number. Stored hashed and never shown again — pass it to the user
            yourself; they must change it at their next sign-in.
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Reset password</button>{' '}
          <button className="btn btn-sm" type="button" onClick={() => { setResetFor(null); setResetPassword(''); }}>Cancel</button>
        </form>
      )}

      <ListFilterBar lf={lf} storageKey="admin-users" noun="logins" />

      {/* FITS THE WINDOW: the table's height is capped to the viewport
          (tbl-fit), so its header stays in view and its own scrollbar is on
          screen — nobody scrolls to the bottom of the page to move sideways. */}
      <div className="tbl-wrap tbl-fit users-table">
        <table>
          <thead>
            {/* Grouped exactly as the model reads: EMPLOYEE, then one group
                per product, then the account. */}
            <tr>
              <th colSpan="2">Employee</th>
              <th colSpan="2">HRMS</th>
              <th colSpan="2">ATS</th>
              <th colSpan="1">Accounts</th>
              <th colSpan="4">Account</th>
            </tr>
            <tr>
              {/* Mobile, branch, STL, assigned clients, open requirements and
                  last login are not on this screen — Users is for logins and
                  roles. Clients and open requirements per person are in
                  Reports → ATS Reports → Recruiters. */}
              <th style={{ width: 90 }}>Employee ID</th><th>Employee Name</th>
              <th>HRMS Role</th><th>Scope</th>
              <th>ATS Role</th><th>Department · TL</th>
              <th>Accounts Role</th>
              <th>Status</th><th>Password changed</th><th>Username</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {page.slice.map((u) => (
              <tr key={u.id}>
                <td><b>{u.employeeId || '—'}</b></td>
                <td className="row-link">
                  {u.employeeRecordId
                    ? <Link to={`/employees/${u.employeeRecordId}`}>{u.name}</Link>
                    : u.name}
                  <div className="small-muted" style={{ fontSize: 11 }}>
                    {u.email}
                  </div>
                </td>
                {/* HRMS — its own role, and the scope that role reaches. */}
                <td>
                  <Combo style={{ minWidth: 104 }} value={shownRole(u.productRoles?.hrms)} onChange={(e) => setProductRole(u, 'hrms', e.target.value)}>
                    {productOptions('hrms', shownRole(u.productRoles?.hrms)).map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td className="cell-muted">
                  {u.scope}
                  {/* EDIT SCOPE lives on HRMS → Employee Management, on that
                      screen's own Scope column. One implementation; this is a
                      link to it, never a second copy. */}
                  {u.employeeRecordId && (
                    <div>
                      <button
                        type="button"
                        className="link-btn"
                        title="Edit which departments, teams and clients this login may reach"
                        onClick={() => setEditing({
                          id: u.id, roleLabel: u.roleLabel || '', name: u.name, role: u.role, branch: u.branch || '', team: u.team || '',
                          atsDepartment: u.atsDepartment || '',
                          atsScopeDepartments: u.atsScopeDepartments || '',
                          atsScopeTeams: u.atsScopeTeams || '',
                          atsScopeClients: u.atsScopeClients || '',
                        })}
                      >
                        Edit scope
                      </button>
                    </div>
                  )}
                </td>
                {/* ATS — its own role, then the desk it works: department, the
                    STL and TL above it, its clients and its requirements. */}
                <td>
                  <Combo style={{ minWidth: 104 }} value={shownRole(u.productRoles?.ats ?? u.atsRole)} onChange={(e) => setProductRole(u, 'ats', e.target.value)}>
                    {productOptions('ats', shownRole(u.productRoles?.ats ?? u.atsRole)).map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td className="cell-muted">
                  {u.department || u.atsDepartment || '—'}
                  {u.atsTl?.length ? <div style={{ fontSize: 11 }}>TL: {u.atsTl.join(', ')}</div> : null}
                </td>
                {/* Accounts — its own role. "No Access" here is a refusal the
                    API enforces, not a hidden menu. */}
                <td>
                  <Combo style={{ minWidth: 104 }} value={shownRole(u.productRoles?.accounts)} onChange={(e) => setProductRole(u, 'accounts', e.target.value)}>
                    {productOptions('accounts', shownRole(u.productRoles?.accounts)).map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td>
                  <span className={'status ' + statusClass(u.status)}>{u.status}</span>
                  {/* Password / account status (hrms-24 §12). */}
                  {u.passwordStatus && <div style={{ marginTop: 4 }}><PasswordBadge ps={u.passwordStatus} /></div>}
                  {hasExited(u) && (
                    <span className="status priority-high" style={{ marginLeft: 4 }} title={u.status === 'Active' ? 'This person has left, but the login still works — disable it.' : 'This person has left.'}>
                      {u.employmentStatus}
                    </span>
                  )}
                </td>
                <td data-testid="pw-changed">
                  {u.passwordStatus?.passwordChangedAt
                    ? <span className="cell-muted">{new Date(u.passwordStatus.passwordChangedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                    : <span className="status pending" title="This login has never changed its password">Never changed</span>}
                </td>
                <td className="cell-muted" data-testid="username-cell" style={{ minWidth: 150 }}>
                  {u.username || '—'}
                  {u.loginsOnEmail > 1 && <div style={{ fontSize: 11 }}><span className="status pending">{u.loginsOnEmail} logins on this email</span></div>}
                  {u.isExtraLogin && <div style={{ fontSize: 11 }}>Separate login of {u.name}</div>}
                </td>
                <td className="users-actions">
                  <div className="row-actions">
                  <button className="btn btn-sm" onClick={() => setEditing({
                    id: u.id, roleLabel: u.roleLabel || '', name: u.name, role: u.role, branch: u.branch || '', team: u.team || '',
                    atsDepartment: u.atsDepartment || '',
                    atsScopeDepartments: u.atsScopeDepartments || '',
                    atsScopeTeams: u.atsScopeTeams || '',
                    atsScopeClients: u.atsScopeClients || '',
                  })}>Edit</button>{' '}
                  <button className="btn btn-sm" disabled={u.id === me?.id} onClick={() => toggleStatus(u)}>
                    {u.status === 'Active' ? 'Disable' : 'Enable'}
                  </button>{' '}
                  <button className="btn btn-sm btn-ghost" onClick={() => { setResetFor(u); setResetPassword(''); }}>
                    Reset password
                  </button>
                  {' '}
                  <button className="btn btn-sm" disabled={u.id === me?.id || u.status !== 'Active'} onClick={() => getResetLink(u)}
                    title="Make a one-time link to hand over. They choose their own password.">
                    Get reset link
                  </button>
                  {' '}
                  <button className="btn btn-sm" onClick={() => sendSignIn(u)}
                    title="Email this login a fresh single-use link to choose its password. Other logins on the same email are not touched.">
                    Send link
                  </button>
                  {' '}
                  {revokeAsk === u.id ? (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={() => revokeLogin(u)}>Yes, switch off and sign out</button>{' '}
                      <button className="btn btn-sm" onClick={() => setRevokeAsk(null)}>No</button>
                    </>
                  ) : (
                    <button className="btn btn-sm" disabled={u.id === me?.id || u.status !== 'Active'} onClick={() => setRevokeAsk(u.id)}
                      title="Switch off this ONE login and end its open sessions. Other logins on the same email keep working.">
                      Sign out and switch off
                    </button>
                  )}
                  {' '}
                  <ViewAsButton userId={u.id} name={u.name} active={u.status === 'Active'}
                    superAdmin={u.role === 'SUPER_ADMIN' || u.hrmsRole === 'SUPER_ADMIN'} />
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan="11"><ListEmpty lf={lf} noun="logins" /></td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="logins" />

      <div className="notice" style={{ marginTop: 14 }}>
        One login, three independent product roles. HRMS, ATS and Accounts each carry their own role on the
        same account: someone can be an Employee in HRMS, a Recruiter in ATS and have no Accounts access at
        all, and their HRMS role never denies their ATS actions. Setting a product to &quot;No Access&quot;
        is a refusal the API enforces. The account-level role (Super Admin, Admin, or an external Client /
        Candidate account) is set on Edit; it is what the Dashboard, Reports and Administration surfaces read.
        A person normally has one login. When one person needs a separate login on the same email (for example a Recruiter login and
        an Accounts login), create it with “Create another separate login on this email”: it has its own password and only the access
        you tick. Switching off, signing out, editing or resetting a login never touches the others. No role ever carries a department in its
        name — a Medical recruiter is department Medical with the ATS role Recruiter.
      </div>

      {editing && (
        <Modal
          title={`Edit — ${editing.name}${editing.roleLabel ? ` · ${editing.roleLabel}` : ''}`}
          onClose={() => setEditing(null)}
          foot={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEditing}>Save</button>
          </>}
        >
          <div className="field"><label>Account-level role</label>
            <Combo value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
              {accountRoles(editing.role).map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
            </Combo></div>
          <div className="notice">
            THE ACCOUNT-LEVEL ROLE, not a product role. It says what kind of account this is — Super Admin,
            Admin, or an external Client / Candidate — and it is what the Dashboard, Reports and
            Administration surfaces resolve against. HRMS, ATS and Accounts each carry their own role,
            editable in their own column on the table.
          </div>
          <div className="field"><label>Branch</label>
            <Combo creatable value={editing.branch} onChange={(e) => setEditing({ ...editing, branch: e.target.value })} placeholder="Select or type a branch">
              <option value="">—</option>
              {withCurrent(masters?.branches, editing.branch).map((b) => <option key={b}>{b}</option>)}
            </Combo></div>
          <div className="field"><label>Assigned team</label>
            <Combo creatable value={editing.team} onChange={(e) => setEditing({ ...editing, team: e.target.value })} placeholder="e.g. Section A">
              <option value="">—</option>
              {withCurrent(masters?.teamNames, editing.team).map((t) => <option key={t}>{t}</option>)}
            </Combo></div>
          <div className="field"><label>Primary ATS department</label>
            <Combo creatable value={editing.atsDepartment} onChange={(e) => setEditing({ ...editing, atsDepartment: e.target.value })}>
              <option value="">All departments</option>
              {withCurrent(deptChoices, editing.atsDepartment).map((d) => <option key={d}>{d}</option>)}
            </Combo></div>
          <div className="notice">
            Data scope. These are what the API itself enforces on every list and
            record — leave them empty to fall back to the employee's own
            department and team. An STL carries several departments here.
          </div>
          {/* TICK BOXES, NOT TYPED COMMAS. The value is still the same
              comma-separated string the API reads, so the PUT body and the
              scope rule are unchanged — only the way it is chosen. */}
          <ScopeChecklist
            label="Department scope"
            hint="Tick every department this login may reach. An STL or a Manager usually carries several."
            options={departmentOptions.map((d) => ({ value: d, label: d }))}
            value={editing.atsScopeDepartments}
            onChange={(v) => setEditing({ ...editing, atsScopeDepartments: v })}
            empty="No departments on the master yet — add them on Administration → Departments & Teams."
          />
          <ScopeChecklist
            label="Team scope"
            hint="Leave every box clear to fall back to their own team."
            options={teamOptions.map((t) => ({ value: t, label: t }))}
            value={editing.atsScopeTeams}
            onChange={(v) => setEditing({ ...editing, atsScopeTeams: v })}
            empty="No teams on the master yet."
          />
          <ScopeChecklist
            label="Client scope"
            hint="A BDE is scoped to the client accounts they own."
            options={clients.map((c) => ({ value: c.id, label: clientLabel(c) }))}
            value={editing.atsScopeClients}
            onChange={(v) => setEditing({ ...editing, atsScopeClients: v })}
            empty="No client accounts yet."
          />
        </Modal>
      )}
      <ActAsHistory />
    </div>
  );
}

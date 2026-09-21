import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { ATS_ROLE_LABELS, atsRoleLabel, DEPTS } from '../../atsVocab';
import Combo from '../../components/Combo.jsx';

// Users / Employee Management (the prototype's usersView, line 9893).
//
// One employee = one user = one login. Granting access never creates a second
// identity: the "Create login" form picks an employee who has none yet and
// attaches a login to that same record.
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
  ats: ['', ...ROLES.filter((r) => r !== 'ACCOUNTANT'), 'CANDIDATE'],
  accounts: ['', ...ROLES],
};

// A stored 'NONE' and an absent role mean the same thing to this screen: the
// product select shows "No Access".
const shownRole = (value) => (value && value !== 'NONE' ? value : '');

const EMPTY_FORM = {
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
  const [filters, setFilters] = useState({ q: '', role: '', status: '', department: '' });
  const [resetFor, setResetFor] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  // Branch / team / scope are read-only text in the table (as in the prototype);
  // this modal is where main's inline editing of them moved to.
  const [editing, setEditing] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  function load() {
    api.get('/admin/users').then((res) => setUsers(res.data)).catch(() => setError('Could not load users.'));
    api.get('/admin/users/employees-without-login').then((res) => setFreeEmployees(res.data)).catch(() => setFreeEmployees([]));
  }
  useEffect(() => {
    load();
    api.get('/clients').then((res) => setClients(res.data)).catch(() => setClients([]));
    api.get('/admin/departments').then((res) => setDepartments(res.data)).catch(() => setDepartments([]));
  }, []);

  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return users.filter((u) => {
      if (filters.role && u.role !== filters.role) return false;
      if (filters.status && u.status !== filters.status) return false;
      if (filters.department && u.department !== filters.department) return false;
      if (q && !`${u.name} ${u.email} ${u.employeeId || ''} ${u.username || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, filters]);

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

  async function submitReset(e) {
    e.preventDefault();
    const ok = await run(() => api.post(`/admin/users/${resetFor.id}/reset-password`, { password: resetPassword }),
      `Password reset for ${resetFor.name}. Share it with them out of band — it is never shown again.`);
    if (ok) { setResetFor(null); setResetPassword(''); }
  }

  // Picking the employee fills their details; this form only decides what they
  // can reach — the prototype's auFill().
  function pickEmployee(id) {
    const emp = freeEmployees.find((e) => e.id === id);
    if (!emp) { set({ employeeId: '' }); return; }
    set({
      employeeId: id,
      name: emp.name,
      email: emp.email || '',
      username: emp.email || emp.name.toLowerCase().replace(/[^a-z]+/g, '.'),
      atsDepartment: emp.department || '',
      branch: emp.branch || emp.location || '',
      team: emp.team || '',
    });
  }

  async function createUser(e) {
    e.preventDefault();
    const ok = await run(
      () => api.post('/admin/users', { ...form, clientId: form.role === 'CLIENT' ? form.clientId : undefined }),
      `${form.name} — login created with the ${atsRoleLabel(form.role)} role.`,
    );
    if (ok) { setForm(EMPTY_FORM); setShowForm(false); }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="page-sub">
            One employee = one user = one login. HRMS, ATS and Accounts roles are independent on the same account.
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

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section" style={{ marginBottom: 14 }}>{notice}</div>}

      {showForm && (
        <form className="card section" onSubmit={createUser}>
          <h3>Grant access to an existing employee</h3>
          <div className="small-muted" style={{ marginBottom: 12 }}>
            {freeEmployees.length
              ? 'Access for an existing employee — no second login is created.'
              : 'Every employee already has a login. You can still create a standalone login (e.g. a client contact) below.'}
          </div>
          <div className="grid-2">
            <label className="field"><span>Employee</span>
              <Combo value={form.employeeId} onChange={(e) => pickEmployee(e.target.value)}>
                <option value="">— standalone login (no employee record) —</option>
                {freeEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name} — {emp.employeeCode}</option>
                ))}
              </Combo></label>
            <label className="field"><span>Full name *</span>
              <input required value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="field"><span>Email *</span>
              <input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></label>
            <label className="field"><span>Username</span>
              <input value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder="filled from the email" /></label>
            <label className="field"><span>Temporary password *</span>
              <input required type="password" minLength="6" value={form.password} onChange={(e) => set({ password: e.target.value })} /></label>
            <label className="field"><span>Role *</span>
              <Combo value={form.role} onChange={(e) => set({ role: e.target.value })}>
                {ROLES.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
              </Combo></label>
            <label className="field"><span>Department scope</span>
              <Combo creatable value={form.atsDepartment} onChange={(e) => set({ atsDepartment: e.target.value })}>
                <option value="">All departments</option>
                {DEPTS.map((d) => <option key={d}>{d}</option>)}
              </Combo></label>
            <label className="field"><span>Branch</span>
              <input value={form.branch} onChange={(e) => set({ branch: e.target.value })} /></label>
            <label className="field"><span>Team</span>
              <input value={form.team} onChange={(e) => set({ team: e.target.value })} placeholder="e.g. Section A" /></label>
            <label className="field"><span>Status</span>
              <Combo value={form.status} onChange={(e) => set({ status: e.target.value })}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </Combo></label>
            {form.role === 'CLIENT' && (
              <label className="field"><span>Client *</span>
                <Combo required value={form.clientId} onChange={(e) => set({ clientId: e.target.value })}>
                  <option value="">—</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Combo>
                <span className="small-muted">A Client login sees only this company.</span></label>
            )}
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Grant access</button>
        </form>
      )}

      {resetFor && (
        <form className="card section" onSubmit={submitReset}>
          <h3>Reset password — {resetFor.name}</h3>
          <div className="grid-2">
            <label className="field"><span>New password *</span>
              <input required type="password" minLength="6" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} /></label>
          </div>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            The password is stored hashed and never shown again — pass it to the user yourself.
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Reset password</button>{' '}
          <button className="btn btn-sm" type="button" onClick={() => { setResetFor(null); setResetPassword(''); }}>Cancel</button>
        </form>
      )}

      <div className="filter-row" style={{ flexWrap: 'wrap' }}>
        <input
          type="text" placeholder="Search name, email, employee ID…"
          value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <Combo value={filters.role} onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))}>
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
        </Combo>
        <Combo value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </Combo>
        <Combo value={filters.department} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d}>{d}</option>)}
        </Combo>
        <button className="btn btn-sm" onClick={() => setFilters({ q: '', role: '', status: '', department: '' })}>Clear</button>
        <span className="small-muted">{rows.length} login(s)</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            {/* Grouped exactly as the model reads: EMPLOYEE, then one group
                per product, then the account. */}
            <tr>
              <th colSpan="5">Employee</th>
              <th colSpan="2">HRMS</th>
              <th colSpan="6">ATS</th>
              <th colSpan="1">Accounts</th>
              <th colSpan="4">Account</th>
            </tr>
            <tr>
              <th>User ID</th><th>Employee ID</th><th>Employee Name</th><th>Mobile</th><th>Branch</th>
              <th>HRMS Role</th><th>Scope</th>
              <th>ATS Role</th><th>Department</th><th>STL</th><th>TL</th>
              <th>Assigned Clients</th><th>Assigned Requirements</th>
              <th>Accounts Role</th>
              <th>Status</th><th>Last Login</th><th>Username</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td><b>{u.id.slice(-6).toUpperCase()}</b></td>
                <td className="small-muted">{u.employeeId || '—'}</td>
                <td className="row-link">
                  {u.employeeRecordId
                    ? <Link to={`/employees/${u.employeeRecordId}`}>{u.name}</Link>
                    : u.name}
                  <div className="small-muted" style={{ fontSize: 11 }}>{u.email}</div>
                </td>
                <td className="cell-muted">{u.mobile || '—'}</td>
                <td className="cell-muted">{u.branch || '—'}</td>
                {/* HRMS — its own role, and the scope that role reaches. */}
                <td>
                  <Combo style={{ minWidth: 120 }} value={shownRole(u.productRoles?.hrms)} onChange={(e) => setProductRole(u, 'hrms', e.target.value)}>
                    {PRODUCT_WORK_ROLES.hrms.map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td className="cell-muted">
                  {u.scope}
                  {/* EDIT SCOPE lives on HRMS → Employee Management, on that
                      screen's own Scope column. One implementation; this is a
                      link to it, never a second copy. */}
                  {u.employeeRecordId && (
                    <div>
                      <Link className="link-btn" to="/employees"
                        title="Edit which departments, teams and clients this login may reach — on Employee Management">
                        Edit scope →
                      </Link>
                    </div>
                  )}
                </td>
                {/* ATS — its own role, then the desk it works: department, the
                    STL and TL above it, its clients and its requirements. */}
                <td>
                  <Combo style={{ minWidth: 120 }} value={shownRole(u.productRoles?.ats ?? u.atsRole)} onChange={(e) => setProductRole(u, 'ats', e.target.value)}>
                    {PRODUCT_WORK_ROLES.ats.map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td className="cell-muted">{u.department || u.atsDepartment || '—'}</td>
                <td className="cell-muted">{u.atsStl?.length ? u.atsStl.join(', ') : '—'}</td>
                <td className="cell-muted">{u.atsTl?.length ? u.atsTl.join(', ') : '—'}</td>
                <td className="cell-muted">{u.assignedClients?.length ? u.assignedClients.join(', ') : '—'}</td>
                <td className="cell-muted">{u.assignedRequirements}</td>
                {/* Accounts — its own role. "No Access" here is a refusal the
                    API enforces, not a hidden menu. */}
                <td>
                  <Combo style={{ minWidth: 120 }} value={shownRole(u.productRoles?.accounts)} onChange={(e) => setProductRole(u, 'accounts', e.target.value)}>
                    {PRODUCT_WORK_ROLES.accounts.map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td><span className={'status ' + statusClass(u.status)}>{u.status}</span></td>
                <td className="cell-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td className="cell-muted">{u.username || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => setEditing({
                    id: u.id, name: u.name, role: u.role, branch: u.branch || '', team: u.team || '',
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
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan="18" className="small-muted" style={{ padding: 16 }}>No logins match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        One login, three independent product roles. HRMS, ATS and Accounts each carry their own role on the
        same account: someone can be an Employee in HRMS, a Recruiter in ATS and have no Accounts access at
        all, and their HRMS role never denies their ATS actions. Setting a product to &quot;No Access&quot;
        is a refusal the API enforces. The account-level role (Super Admin, Admin, or an external Client /
        Candidate account) is set on Edit; it is what the Dashboard, Reports and Administration surfaces read.
        Nothing here creates a second account, and no role ever carries a department in its name — a Medical
        recruiter is department Medical with the ATS role Recruiter.
      </div>

      {editing && (
        <Modal
          title={`Edit — ${editing.name}`}
          onClose={() => setEditing(null)}
          foot={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEditing}>Save</button>
          </>}
        >
          <div className="field"><label>Account-level role</label>
            <Combo value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
            </Combo></div>
          <div className="notice">
            THE ACCOUNT-LEVEL ROLE, not a product role. It says what kind of account this is — Super Admin,
            Admin, or an external Client / Candidate — and it is what the Dashboard, Reports and
            Administration surfaces resolve against. HRMS, ATS and Accounts each carry their own role,
            editable in their own column on the table.
          </div>
          <div className="field"><label>Branch</label>
            <input value={editing.branch} onChange={(e) => setEditing({ ...editing, branch: e.target.value })} /></div>
          <div className="field"><label>Assigned team</label>
            <input value={editing.team} onChange={(e) => setEditing({ ...editing, team: e.target.value })} placeholder="e.g. Section A" /></div>
          <div className="field"><label>Primary ATS department</label>
            <Combo creatable value={editing.atsDepartment} onChange={(e) => setEditing({ ...editing, atsDepartment: e.target.value })}>
              <option value="">All departments</option>
              {DEPTS.map((d) => <option key={d}>{d}</option>)}
            </Combo></div>
          <div className="notice">
            Data scope. These are what the API itself enforces on every list and
            record — leave them empty to fall back to the employee's own
            department and team. An STL carries several departments here.
          </div>
          <div className="field"><label>Department scope (comma-separated)</label>
            <input
              value={editing.atsScopeDepartments}
              onChange={(e) => setEditing({ ...editing, atsScopeDepartments: e.target.value })}
              placeholder="e.g. Medical,IT"
            /></div>
          <div className="field"><label>Team scope (comma-separated)</label>
            <input
              value={editing.atsScopeTeams}
              onChange={(e) => setEditing({ ...editing, atsScopeTeams: e.target.value })}
              placeholder="e.g. Medical Team-A"
            /></div>
          <div className="field"><label>Client scope (BDE — client ids, comma-separated)</label>
            <input
              value={editing.atsScopeClients}
              onChange={(e) => setEditing({ ...editing, atsScopeClients: e.target.value })}
            /></div>
        </Modal>
      )}
    </div>
  );
}

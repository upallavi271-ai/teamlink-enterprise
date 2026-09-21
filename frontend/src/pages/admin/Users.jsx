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
// ROLE MODEL.
// Each login now carries THREE independent product-access booleans (HRMS /
// ATS / Accounts) on the same account, an ATS working role derived from the
// employee's designation, and a stored data scope. The HRMS / ATS / Accounts
// columns below are therefore REAL and EDITABLE — a tick grants the product, a
// select sets the ATS role, and Edit sets the department / team / client scope.
// Changing any of them changes what the API itself allows, not just the UI.

const ROLES = Object.keys(ATS_ROLE_LABELS);
const STATUSES = ['Active', 'Inactive', 'Suspended'];

const ATS_WORK_ROLES = ['', 'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'CLIENT'];

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

  // Grant or revoke one product on this login. Never a second account.
  function setProduct(u, product, value) {
    const key = { hrms: 'hrmsAccess', ats: 'atsAccess', accounts: 'accountsAccess' }[product];
    run(() => api.put(`/admin/users/${u.id}`, { [key]: value }),
      `${u.name} — ${product.toUpperCase()} access ${value ? 'granted' : 'removed'} (same login).`);
  }

  function setAtsRole(u, atsRole) {
    run(() => api.put(`/admin/users/${u.id}`, { atsRole: atsRole || null, atsAccess: !!atsRole }),
      `${u.name} — ATS role: ${atsRole || 'none'} (scope stays ${u.scope}).`);
  }

  function changeRole(u, role) {
    // The change lands on the user's next login — it never creates a second account.
    run(() => api.put(`/admin/users/${u.id}`, { role }),
      `${u.name} — role: ${atsRoleLabel(u.role)} → ${atsRoleLabel(role)} (same login, no new account).`);
  }

  async function saveEditing() {
    const ok = await run(
      () => api.put(`/admin/users/${editing.id}`, {
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
            {/* The prototype's fifteen columns, in its order (usersView, line
                9911). Username, Role and Actions are main-only and appended. */}
            <tr>
              <th>User ID</th><th>Employee ID</th><th>Employee Name</th>
              <th>Department</th><th>Branch</th><th>Team</th>
              <th>HRMS Role</th><th>ATS Role</th><th>Accounts Role</th>
              <th>Status</th><th>Scope</th><th>Assigned Clients</th>
              <th>Assigned Requirements</th><th>Assigned Team</th><th>Last Login</th>
              <th>Username</th><th>Role</th><th>Actions</th>
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
                <td className="cell-muted">{u.department || '—'}</td>
                <td className="cell-muted">{u.branch || '—'}</td>
                <td className="cell-muted">{u.team || '—'}</td>
                {/* Real, editable product access — one login, three products. */}
                <td>
                  <label className="small-muted" style={{ whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={!!u.products?.hrms} onChange={(e) => setProduct(u, 'hrms', e.target.checked)} />{' '}
                    {u.products?.hrms ? 'HRMS' : 'No Access'}
                  </label>
                </td>
                <td>
                  <Combo style={{ minWidth: 120 }} value={u.atsRole || ''} onChange={(e) => setAtsRole(u, e.target.value)}>
                    {ATS_WORK_ROLES.map((r) => <option key={r || 'none'} value={r}>{r ? atsRoleLabel(r) : 'No Access'}</option>)}
                  </Combo>
                </td>
                <td>
                  <label className="small-muted" style={{ whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={!!u.products?.accounts} onChange={(e) => setProduct(u, 'accounts', e.target.checked)} />{' '}
                    {u.products?.accounts ? 'Accounts' : 'No Access'}
                  </label>
                </td>
                <td><span className={'status ' + statusClass(u.status)}>{u.status}</span></td>
                <td className="cell-muted">
                  {u.scope}
                  {/* EDIT SCOPE lives on HRMS → Employee Management, on that
                      screen''s own Scope column. One implementation; this is a
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
                <td className="cell-muted">{u.assignedClients?.length ? u.assignedClients.join(', ') : '—'}</td>
                <td className="cell-muted">{u.assignedRequirements}</td>
                <td className="cell-muted">{u.team || u.atsDepartment || '—'}</td>
                <td className="cell-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td className="cell-muted">{u.username || '—'}</td>
                <td>
                  <Combo style={{ minWidth: 130 }} value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
                    {ROLES.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
                  </Combo>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => setEditing({
                    id: u.id, name: u.name, branch: u.branch || '', team: u.team || '',
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
        Changing a role here takes effect on that user&apos;s next login — it never creates a second account.
        An employee created in HRMS is linked to a user automatically; assigning an ATS or Accounts role adds
        product access to that same login. HRMS, ATS and Accounts are shown here derived from the single stored
        role; they become independently editable when the three-role split lands.
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

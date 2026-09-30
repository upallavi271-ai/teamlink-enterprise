// ---------------------------------------------------------------------------
// Role Catalog -> CUSTOM ROLES (+ Add Role / Edit / Activate / Deactivate).
//
// Roles are data (backend utils/roleRegistry.js). A custom role has its own
// permission matrix — modules x View/Add/Edit/Delete/Approve/Reject/Export/
// Import — and is DENY BY DEFAULT: it may do exactly what is ticked. Saving
// writes the engine's RoleAccess rows, so the API enforces it at once, and the
// role appears in every role dropdown (Add Employee, Users, filters) with no
// code change. Finer per-feature detail stays on Edit Access.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { atsRoleLabel } from '../../atsVocab';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { invalidateMasters } from '../../utils/masters';

const ACTION_LABEL = {
  view: 'View', add: 'Add', edit: 'Edit', delete: 'Delete', approve: 'Approve', reject: 'Reject', export: 'Export', import: 'Import',
};
const PRODUCT_LABEL = { hrms: 'HRMS', ats: 'ATS', accounts: 'Accounts' };
const EMPTY = {
  name: '', description: '', status: 'Active', scopeLevel: 'OWN', behavesAts: '', permissions: {}, template: '',
};

export default function CustomRoles({ roles, addSignal, onMeta, onChanged, onEditAccess }) {
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(null); // { code?, ...EMPTY }
  const [formError, setFormError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/admin/role-catalog/meta')
      .then((r) => { setMeta(r.data); if (onMeta) onMeta({ canManage: r.data.canManage }); })
      .catch(() => setMeta(null));
  }, []);
  useEffect(() => { if (addSignal) openAdd(); }, [addSignal]);

  function openAdd() { setFormError(''); setNotice(''); setForm({ ...EMPTY }); }
  function openEdit(r) {
    setFormError(''); setNotice('');
    setForm({
      code: r.role,
      name: r.name,
      description: r.description || '',
      status: r.status || 'Active',
      scopeLevel: r.scopeLevel || 'OWN',
      behavesAts: (r.behavesLike && r.behavesLike.ats) || '',
      permissions: JSON.parse(JSON.stringify(r.permissions || {})),
      template: '',
      holders: r.users,
      wasStatus: r.status,
    });
  }
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const has = (row, a) => (form.permissions[row] || []).includes(a);
  function toggle(row, a) {
    setForm((f) => {
      const cur = new Set(f.permissions[row] || []);
      if (cur.has(a)) cur.delete(a); else cur.add(a);
      // Any action implies View — a role that may edit a record it cannot
      // open is not a role anybody can use.
      if (a !== 'view' && cur.has(a)) cur.add('view');
      return { ...f, permissions: { ...f.permissions, [row]: meta.actions.filter((x) => cur.has(x)) } };
    });
  }
  function toggleRow(row) {
    setForm((f) => {
      const all = meta.actions.every((a) => (f.permissions[row] || []).includes(a));
      return { ...f, permissions: { ...f.permissions, [row]: all ? [] : [...meta.actions] } };
    });
  }
  async function applyTemplate(code) {
    set({ template: code });
    if (!code) return;
    try {
      const r = await api.get(`/admin/role-catalog/template/${code}`);
      set({ permissions: r.data.matrix || {}, scopeLevel: r.data.scopeLevel === 'ALL' ? form.scopeLevel : (r.data.scopeLevel || form.scopeLevel) });
    } catch (err) {
      setFormError(err.response?.data?.error || 'Could not load that role’s permissions.');
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true); setFormError('');
    const body = {
      name: form.name,
      description: form.description,
      status: form.status,
      scopeLevel: form.scopeLevel,
      behavesLike: form.behavesAts ? { ats: form.behavesAts } : {},
      permissions: form.permissions,
    };
    try {
      const res = form.code
        ? await api.put(`/admin/role-catalog/roles/${form.code}`, body)
        : await api.post('/admin/role-catalog/roles', body);
      const inactiveWarn = res.data.status === 'Inactive' && res.data.holders
        ? ` ${res.data.holders} login(s) still hold it and keep its permissions until they are given another role.` : '';
      setNotice(form.code
        ? `"${res.data.name}" saved.${inactiveWarn}`
        : `"${res.data.name}" created. It is now in Employee Management → Add Employee → Role and in every role picker.`);
      setForm(null);
      invalidateMasters(); // the new / renamed role joins every dropdown now
      if (onChanged) onChanged();
    } catch (err) {
      setFormError(err.response?.data?.error || 'That role could not be saved.');
    } finally { setBusy(false); }
  }

  async function setStatus(r, status) {
    setError(''); setNotice('');
    if (status === 'Inactive' && r.users
      && !window.confirm(`${r.users} login(s) hold "${r.name}". They keep its permissions until reassigned, but it disappears from every dropdown. Deactivate?`)) return;
    try {
      const res = await api.put(`/admin/role-catalog/roles/${r.role}`, { status });
      setNotice(`"${res.data.name}" ${status === 'Inactive' ? 'deactivated' : 'activated'}.`);
      invalidateMasters();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    }
  }

  const canManage = !!(meta && meta.canManage);

  // THE FILTER STANDARD for the custom roles: Search · Status · Product, Sort.
  const lf = useListFilters(roles, [
    { key: 'q', type: 'search', placeholder: 'Search custom role…', get: (r) => `${r.name} ${r.description || ''}` },
    { key: 'status', label: 'Status', allLabel: 'All statuses', primary: true, get: (r) => r.status, options: ['Active', 'Inactive'] },
    { key: 'product', label: 'Product', allLabel: 'All products', primary: true,
      get: (r) => ['hrms', 'ats', 'accounts'].filter((p) => r.grants?.[p]),
      options: Object.entries(PRODUCT_LABEL).map(([value, label]) => ({ value, label })) },
  ], {
    sorts: [
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name).localeCompare(String(b.name)) },
      { key: 'users', label: 'Most users', cmp: (a, b) => (b.users || 0) - (a.users || 0) },
    ],
  });
  const scopeLabel = (id) => (meta?.scopeLevels || []).find((s) => s.id === id)?.label || id;
  const grants = form ? ['hrms', 'ats', 'accounts'].filter((p) => (meta?.rows || [])
    .some((row) => row.product === p && (form.permissions[row.id] || []).length)) : [];

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>Custom roles</h3>
          <div className="cell-muted" style={{ fontSize: 12 }}>
            Roles you add. Deny by default: a custom role may do exactly what its permissions tick, and nothing else.
          </div>
        </div>
        {canManage && <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Role</button>}
      </div>

      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginTop: 8 }}>{notice}</div>}

      {roles.length > 0 && <div style={{ marginTop: 10 }}><ListFilterBar lf={lf} storageKey="admin-custom-roles" noun="custom roles" /></div>}
      {lf.rows.map((r) => (
        <div className="assign-row" key={r.role}>
          <span>
            <b>{r.name} · {r.users} user{r.users === 1 ? '' : 's'}</b>{' '}
            <span className={`status ${r.status === 'Inactive' ? 'hold' : 'active'}`}>{r.status}</span>
            {r.description && <><br /><span className="cell-muted" style={{ fontSize: 12 }}>{r.description}</span></>}
            <br />
            <span className="cell-muted" style={{ fontSize: 12 }}>
              Scope: {scopeLabel(r.scopeLevel)}
              {r.behavesLike?.ats ? ` · ATS workflow as ${atsRoleLabel(r.behavesLike.ats)}` : ''}
              {' · '}Products: {['hrms', 'ats', 'accounts'].filter((p) => r.grants?.[p]).map((p) => PRODUCT_LABEL[p]).join(' · ') || 'none'}
            </span>
            {r.status === 'Inactive' && r.users > 0 && (
              <><br /><span className="small-muted">Inactive — {r.users} login(s) still hold it and keep working until reassigned.</span></>
            )}
          </span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {canManage && <button className="btn btn-sm" onClick={() => openEdit(r)}>Edit</button>}
            <button className="btn btn-sm" onClick={() => onEditAccess(r.role)} title="Per-feature detail, incl. Dashboard and Administration">Edit Access</button>
            {canManage && (r.status === 'Inactive'
              ? <button className="btn btn-sm" onClick={() => setStatus(r, 'Active')}>Activate</button>
              : <button className="btn btn-sm" onClick={() => setStatus(r, 'Inactive')}>Deactivate</button>)}
          </span>
        </div>
      ))}
      {roles.length === 0 && (
        <div className="empty-mini">No custom roles yet.{canManage ? ' Use + Add Role to create one.' : ''}</div>
      )}
      {roles.length > 0 && lf.rows.length === 0 && <ListEmpty lf={lf} noun="custom roles" />}

      {form && meta && (
        <Modal
          title={form.code ? `Edit role — ${form.name}` : 'Add Role'}
          size="xwide"
          onClose={() => setForm(null)}
          foot={<>
            <button className="btn" type="button" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" type="submit" form="custom-role-form" disabled={busy}>{busy ? 'Saving…' : 'Save role'}</button>
          </>}
        >
          <form id="custom-role-form" onSubmit={save}>
            {formError && <div className="error-text" style={{ marginBottom: 8 }}>{formError}</div>}
            <div className="grid-2">
              <label className="field"><span>Role name *</span>
                <input required maxLength={60} value={form.name} autoFocus placeholder="e.g. Senior Recruiter" onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="field"><span>Status</span>
                <Combo value={form.status} onChange={(e) => set({ status: e.target.value })}>
                  <option>Active</option>
                  <option>Inactive</option>
                </Combo>
                {form.code && form.status === 'Inactive' && form.wasStatus !== 'Inactive' && form.holders > 0 && (
                  <span className="small-muted">{form.holders} login(s) hold it; they keep working until reassigned.</span>
                )}
              </label>
            </div>
            <label className="field"><span>Description</span>
              <input maxLength={300} value={form.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <div className="grid-3">
              <label className="field"><span>Data scope</span>
                <Combo value={form.scopeLevel} onChange={(e) => set({ scopeLevel: e.target.value })}>
                  {meta.scopeLevels.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </Combo>
                <span className="small-muted">Which records it sees: own, the team, the department(s), or the whole company.</span>
              </label>
              <label className="field"><span>ATS workflow behaves like</span>
                <Combo value={form.behavesAts} onChange={(e) => set({ behavesAts: e.target.value })}>
                  <option value="">(from the scope)</option>
                  {meta.behavesLikeAts.map((r) => <option key={r} value={r}>{atsRoleLabel(r)}</option>)}
                </Combo>
                <span className="small-muted">Which pipeline stages it owns. Grants no permission by itself.</span>
              </label>
              <label className="field"><span>Starting template</span>
                <Combo value={form.template} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">Copy permissions from…</option>
                  {meta.templates.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
                </Combo>
                <span className="small-muted">Fills the matrix below; adjust it before saving.</span>
              </label>
            </div>

            <div className="tbl-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Module</th>
                    {meta.actions.map((a) => <th key={a} style={{ textAlign: 'center' }}>{ACTION_LABEL[a] || a}</th>)}
                    <th style={{ textAlign: 'center' }}>All</th>
                  </tr>
                </thead>
                <tbody>
                  {meta.rows.map((row) => {
                    const all = meta.actions.every((a) => has(row.id, a));
                    return (
                      <tr key={row.id}>
                        <td>
                          <b>{row.label}</b>
                          <div className="small-muted" style={{ fontSize: 11 }}>{row.product ? PRODUCT_LABEL[row.product] : 'follows the products above'}</div>
                        </td>
                        {meta.actions.map((a) => (
                          <td key={a} style={{ textAlign: 'center' }}>
                            <input type="checkbox" style={{ width: 'auto' }} checked={has(row.id, a)} onChange={() => toggle(row.id, a)} />
                          </td>
                        ))}
                        <td style={{ textAlign: 'center' }}>
                          <button className="btn btn-sm btn-ghost" type="button" onClick={() => toggleRow(row.id)}>{all ? 'None' : 'All'}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="small-muted" style={{ marginTop: 8 }}>
              Grants: {grants.length ? grants.map((p) => PRODUCT_LABEL[p]).join(' + ') : <b>nothing yet — tick at least one permission</b>}.
              {' '}Reject is the approval decision (same right as Approve); Import needs Add. Attendance, Regularization and
              Timesheet share one permission, as do LMS / Performance / Rewards and Assets / Documents. Saving
              {form.code ? ' rewrites these modules for this role (Dashboard / Administration detail on Edit Access is kept).' : ' creates the role; it is enforced by the API immediately.'}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { atsRoleLabel } from '../../atsVocab';

// Role Catalog (the prototype's roleCatalogView + openEditAccess +
// openConfigureFeatures, lines 10098-10210).
//
// WHICH PERMISSION MATRIX: the prototype carries two that were never reconciled.
// `state.rolePermissions` covers four modules only (candidates, requirements,
// clients, invoices) with no HRMS and no Accounts at all. `state.roleAccess` /
// roleAccessFor() covers ten modules x 4-8 named features x 7 actions. The Role
// Catalog UI reads and writes the SECOND one, and it is the only one that can
// describe this app, so that is what this screen and
// backend/src/utils/roleAccess.js implement.
//
// THE PRODUCT DIMENSION. The catalog reads
//
//   PRODUCT → MODULE → FEATURE → ACTION
//
// because a role name is not one thing any more: a login carries an HRMS
// role, an ATS role and an Accounts role, and the engine resolves the one
// belonging to the product the module sits in. Grants are therefore STORED
// per product, so the same role name can mean one thing in ATS and another in
// HRMS without anybody inventing a second role name for it.
//
// Role list -> Edit Access (product > module toggles) -> Configure
// (feature x action grid).

// The products, in the order the sidebar shows them. Modules carry their own
// product from the API (`m.product`), so nothing here hard-codes which module
// belongs where.
const PRODUCT_LABEL = {
  ats: 'ATS',
  hrms: 'HRMS',
  accounts: 'Accounts',
  '*': 'Core — every product',
};
const PRODUCT_ORDER = ['ats', 'hrms', 'accounts', '*'];

// What a product row means, said once.
const PRODUCT_NOTE = {
  ats: 'Resolved against this login’s ATS role.',
  hrms: 'Resolved against this login’s HRMS role.',
  accounts: 'Resolved against this login’s Accounts role. A login whose Accounts role is None is refused here outright.',
  '*': 'Not part of any one product — resolved against every role the login holds, its account-level role included.',
};

export default function RoleCatalog() {
  const [roles, setRoles] = useState([]);
  const [editing, setEditing] = useState(null); // { role, scope, actions, modules[] }
  const [configuring, setConfiguring] = useState(null); // moduleId
  const [draft, setDraft] = useState({}); // unsaved feature grid for `configuring`
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function load() {
    api.get('/admin/role-catalog').then((res) => setRoles(res.data)).catch(() => setError('Could not load the role catalog.'));
  }
  useEffect(load, []);

  async function openEditAccess(role) {
    setError(''); setNotice(''); setConfiguring(null);
    try {
      const res = await api.get(`/admin/role-catalog/${role}/access`);
      setEditing(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open that role.');
    }
  }

  // Toggling a module is saved immediately — the prototype does the same.
  async function toggleModule(moduleId, enabled) {
    setError(''); setNotice('');
    try {
      const res = await api.put(`/admin/role-catalog/${editing.role}/modules/${moduleId}`, { enabled });
      setEditing((e) => ({
        ...e,
        modules: e.modules.map((m) => (m.id === moduleId ? { ...m, moduleEnabled: res.data.moduleEnabled } : m)),
      }));
      setNotice(`${res.data.label} ${enabled ? 'enabled' : 'disabled'} for ${atsRoleLabel(editing.role)}.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That toggle could not be saved.');
    }
  }

  function openConfigure(moduleId) {
    const mod = editing.modules.find((m) => m.id === moduleId);
    // Deep-copy so ticking boxes doesn't mutate state before Save.
    setDraft(JSON.parse(JSON.stringify(mod.features)));
    setConfiguring(moduleId);
    setNotice('');
  }

  function toggleAction(feature, action) {
    setDraft((d) => ({ ...d, [feature]: { ...d[feature], [action]: !d[feature]?.[action] } }));
  }

  function toggleFeatureRow(feature, value) {
    setDraft((d) => {
      const next = { ...d[feature] };
      editing.actions.forEach((a) => { next[a] = value; });
      return { ...d, [feature]: next };
    });
  }

  async function saveFeatures() {
    setError(''); setNotice('');
    const mod = editing.modules.find((m) => m.id === configuring);
    try {
      const res = await api.put(`/admin/role-catalog/${editing.role}/modules/${configuring}/features`, { features: draft });
      setEditing((e) => ({
        ...e,
        modules: e.modules.map((m) => (m.id === configuring ? { ...m, features: res.data.features } : m)),
      }));
      setConfiguring(null);
      setNotice(`Feature permissions saved for ${atsRoleLabel(editing.role)} — ${mod.label}.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Those permissions could not be saved.');
    }
  }

  const mod = configuring && editing ? editing.modules.find((m) => m.id === configuring) : null;

  // The module list, grouped by product — the top level of
  // Product → Module → Feature → Action.
  const byProduct = (modules) => PRODUCT_ORDER
    .map((p) => [p, modules.filter((m) => (m.product || '*') === p)])
    .filter(([, list]) => list.length);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Role Catalog</h1>
          <div className="page-sub">Real user counts per role. Click Edit Access to configure a role&apos;s page access.</div>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="panel">
        {roles.map((r) => (
          <div className="assign-row" key={r.role}>
            <span>
              <b>{atsRoleLabel(r.role)} · {r.users} user{r.users === 1 ? '' : 's'}</b>
              <br />
              <span className="cell-muted" style={{ fontSize: 12 }}>{r.scope || '—'}</span>
              <br />
              {/* WHICH PRODUCTS this role reaches — the first level of the
                  catalog, before any module. */}
              <span className="cell-muted" style={{ fontSize: 12 }}>
                Products: {(r.products || []).length
                  ? (r.products || []).map((p) => PRODUCT_LABEL[p] || p).join(' · ')
                  : 'none'}
              </span>
            </span>
            <button className="btn btn-sm" onClick={() => openEditAccess(r.role)}>Edit Access</button>
          </div>
        ))}
        {roles.length === 0 && <div className="empty-mini">No roles.</div>}
      </div>

      <div className="notice" style={{ marginTop: 12 }}>
        Product → Module → Feature → Action. Everything here is ENFORCED: it is the same matrix the API
        checks on every request and the sidebar renders from, so un-ticking a box refuses the call, not just
        the button. Grants are stored per product, which is what lets one role name mean different things in
        ATS and in HRMS — a login holds an HRMS role, an ATS role and an Accounts role, and each module is
        answered by the role for its own product.
      </div>

      {editing && !configuring && (
        <Modal
          title={`Edit Access — ${atsRoleLabel(editing.role)}`}
          size="xwide"
          onClose={() => setEditing(null)}
          foot={<button className="btn btn-primary" onClick={() => setEditing(null)}>Done</button>}
        >
          <div className="cell-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Product → Module → Feature → Action. Toggle module access, or click Configure for
            feature-level detail. Each product&apos;s grants are stored separately, so what this role may do
            in ATS is not what it may do in HRMS.
          </div>
          {byProduct(editing.modules).map(([product, modules]) => (
            <div key={product} style={{ marginBottom: 14 }}>
              <h3 style={{ margin: '0 0 2px' }}>{PRODUCT_LABEL[product] || product}</h3>
              <div className="cell-muted" style={{ fontSize: 12, marginBottom: 6 }}>{PRODUCT_NOTE[product]}</div>
              {modules.map((m) => (
                <div className="assign-row" key={m.id}>
                  <label style={{ display: 'flex', gap: 9, alignItems: 'center', flex: 1, cursor: 'pointer' }}>
                    <input
                      type="checkbox" style={{ width: 'auto' }}
                      checked={!!m.moduleEnabled}
                      onChange={(e) => toggleModule(m.id, e.target.checked)}
                    />
                    {m.label}
                  </label>
                  <button className="btn btn-sm" onClick={() => openConfigure(m.id)}>Configure →</button>
                </div>
              ))}
            </div>
          ))}
        </Modal>
      )}

      {editing && mod && (
        <Modal
          title={`Configure — ${mod.label}`}
          size="xwide"
          onClose={() => setConfiguring(null)}
          foot={<>
            <button className="btn" onClick={() => setConfiguring(null)}>← Back to modules</button>
            <button className="btn btn-primary" onClick={saveFeatures}>Save changes</button>
          </>}
        >
          <div className="cell-muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {PRODUCT_LABEL[mod.product || '*']} · {mod.featureNames.length} feature(s) · {atsRoleLabel(editing.role)}
            <br />
            {PRODUCT_NOTE[mod.product || '*']}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Feature</th>
                  {editing.actions.map((a) => <th key={a} style={{ textAlign: 'center' }}>{a.toUpperCase()}</th>)}
                  {/* main-only: a row-level all/none shortcut over the prototype's seven boxes. */}
                  <th style={{ textAlign: 'center' }}>ALL</th>
                </tr>
              </thead>
              <tbody>
                {mod.featureNames.map((f) => {
                  const rec = draft[f] || {};
                  const all = editing.actions.every((a) => rec[a]);
                  return (
                    <tr key={f}>
                      <td><b>{f}</b></td>
                      {editing.actions.map((a) => (
                        <td key={a} style={{ textAlign: 'center' }}>
                          <input type="checkbox" style={{ width: 'auto' }} checked={!!rec[a]} onChange={() => toggleAction(f, a)} />
                        </td>
                      ))}
                      <td style={{ textAlign: 'center' }}>
                        <button className="btn btn-sm btn-ghost" type="button" onClick={() => toggleFeatureRow(f, !all)}>
                          {all ? 'None' : 'All'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

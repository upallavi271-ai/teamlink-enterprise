import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import { Link } from 'react-router-dom';
import ListFilterBar, { useListFilters } from '../../components/ui/ListFilters.jsx';

// Organization Structure — the prototype's adminOrgStructureView() (line
// 10486). The approval & escalation chain requests travel down: leave,
// attendance, alerts and issues escalate top-to-bottom through this list.
// Drag the handle to reorder; roles can be edited or paused, never deleted.
// Departments, Branches and Teams sit underneath it.

export default function OrgStructure() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null); // { id, name, description }
  const [adding, setAdding] = useState(null); // { name, description }
  const [addingDept, setAddingDept] = useState(null);
  const [addingTeam, setAddingTeam] = useState(null);
  const dragId = useRef(null);

  function load() {
    api.get('/admin/org-structure').then((res) => setData(res.data)).catch(() => setError('Could not load the organization structure.'));
  }
  useEffect(load, []);

  async function run(fn, message) {
    setError(''); setNotice('');
    try { await fn(); if (message) setNotice(message); load(); return true; } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
      return false;
    }
  }

  function onDrop(targetId) {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    const ids = data.roles.map((r) => r.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    const moved = data.roles.find((r) => r.id === from);
    run(() => api.put('/admin/org-structure/reorder', { order: ids }), `${moved.name} moved to position ${toIdx + 1}.`);
  }

  async function saveEdit() {
    const ok = await run(() => api.put(`/admin/org-structure/${editing.id}`, { name: editing.name, description: editing.description }), 'Role updated.');
    if (ok) setEditing(null);
  }

  async function saveAdd() {
    const ok = await run(() => api.post('/admin/org-structure', adding), `${adding.name} added just below Super Admin. It sees new requests now — to make it approve them, set it to "Required approver" in Leave → Approval Workflow Levels.`);
    if (ok) setAdding(null);
  }

  // THE FILTER STANDARD for Departments, Branches & Teams (one bar over the
  // three lists): Search · Type · Department. The approval chain above is an
  // ordered, drag-to-reorder list of a handful of levels, so it is not
  // filtered — hiding a level would make the drag order ambiguous.
  const places = useMemo(() => (data ? [
    ...data.departments.map((d) => ({ kind: 'Department', key: `d${d.id}`, name: d.name, sub: d.parent ? `Under ${d.parent}` : 'Top-level', dept: d.name })),
    ...data.branches.map((b) => ({ kind: 'Branch', key: `b${b.name}`, name: b.name, sub: b.location || '—', dept: '' })),
    ...data.teams.map((t) => ({ kind: 'Team', key: `t${t.id}`, name: t.name, sub: t.department || '—', dept: t.department || '' })),
  ] : []), [data]);
  const lf = useListFilters(places, [
    { key: 'q', type: 'search', placeholder: 'Search department, branch or team…', get: (p) => `${p.name} ${p.sub}` },
    { key: 'kind', label: 'Type', allLabel: 'All types', primary: true, get: (p) => p.kind, options: ['Department', 'Branch', 'Team'] },
    { key: 'dept', label: 'Department', allLabel: 'All departments', primary: true, get: (p) => p.dept },
  ]);
  const shown = (kind) => lf.rows.filter((p) => p.kind === kind);
  const filtering = lf.activeCount > 0;
  const none = (label) => (filtering ? `No ${label} match these filters.` : `No ${label} yet.`);

  if (!data) return <div className="page-head"><h1>Organization Structure</h1></div>;

  return (
    <div>
      <div className="page-head">
        <div><h1>Organization Structure</h1>
          <div className="page-sub">
            Who approves requests (leave, attendance fixes, resignations). Add a role and it joins the
            approval chain. Pause a role and it stops approving. Remove a role and it leaves the chain.
          </div></div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="panel panel-pad">
        <h3 style={{ fontSize: 14, marginBottom: 4 }}>Approval &amp; escalation workflow</h3>
        <div className="cell-muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
          Top = highest authority. A new role is placed just below Super Admin — drag the ⠿ handle to move it.
          Roles below “Employee” do not approve anything.
        </div>
        {data.roles.map((r, i) => (
          <div key={r.id}>
            <div
              className="panel"
              style={{ padding: '12px 16px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 12, opacity: r.paused ? 0.55 : 1 }}
              draggable
              onDragStart={() => { dragId.current = r.id; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(r.id)}
            >
              <span style={{ cursor: 'grab', color: 'var(--ink-soft)', fontSize: 14 }} title="Drag to reorder">⠿</span>
              <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--navy-tint)', color: 'var(--navy)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flex: '0 0 auto' }}>{i + 1}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {r.name}
                  {r.system ? <span className="status active">System</span> : (r.paused ? <span className="status pending">Paused — skipped</span> : null)}
                  {(() => {
                    // Spec item 19 — say plainly what this row means for approvals.
                    const c = (data.chain || []).find((x) => x.id === r.id);
                    if (!c || r.paused) return null;
                    return c.inChain
                      ? <span className="status active">Approves requests</span>
                      : <span className="cell-muted" style={{ fontWeight: 400, fontSize: 12 }}>Not an approver — move it above Employee to add it</span>;
                  })()}
                </div>
                <div className="cell-muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {r.description}
                  {r.approveDays && !r.paused
                    ? <> · Can approve leave up to <b>{r.approveDays} day(s)</b>; longer requests escalate.</>
                    : null}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm" onClick={() => setEditing({ id: r.id, name: r.name, description: r.description })}>Edit</button>
                {!r.system && (
                  <button className="btn btn-sm" onClick={() => run(() => api.post(`/admin/org-structure/${r.id}/toggle-pause`), `${r.name}${r.paused ? ' resumed — it approves new requests again.' : ' paused — it will not approve requests until you resume it.'}`)}>
                    {r.paused ? 'Resume' : 'Pause'}
                  </button>
                )}
                {!r.system && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      if (!confirm(`Remove "${r.name}" from the approval chain? Requests waiting on it move to the next approver.`)) return;
                      run(() => api.delete(`/admin/org-structure/${r.id}`), `${r.name} removed from the approval chain.`);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {i < data.roles.length - 1 && (
              <div style={{ textAlign: 'center', color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1 }}>↓</div>
            )}
          </div>
        ))}
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setAdding({ name: '', description: '' })}>+ Add approval level</button>
        {/* This adds a level to the APPROVAL CHAIN, not a role an employee can
            hold — that is Role Catalog -> Add Role (a designation). */}
        <div className="small-muted" style={{ marginTop: 6 }}>
          To create a role for employees, use <Link to="/admin/roles">Role Catalog → Add Role</Link>.
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 22 }}>Departments, Branches &amp; Teams</div>
      <ListFilterBar lf={lf} storageKey="admin-org-places" noun="entries" />
      <div className="two-col">
        <div className="panel panel-pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, margin: 0 }}>Departments</h3>
            <button className="btn btn-sm btn-primary" onClick={() => setAddingDept('')}>+ Add Department</button>
          </div>
          {shown('Department').length === 0
            ? <div className="empty-mini">{none('departments')}</div>
            : shown('Department').map((d) => (
              <div className="assign-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={d.key}>
                <span>{d.name}</span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{d.sub}</span>
              </div>
            ))}
        </div>
        <div>
          <div className="panel panel-pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ fontSize: 13, margin: 0 }}>Branches</h3>
              {/* The prototype has an + Add Branch button here. In this app a
                  branch is not its own record — it is the office an employee is
                  posted to — so branches are listed, not created here. */}
            </div>
            {shown('Branch').length === 0
              ? <div className="empty-mini">{none('branches')}</div>
              : shown('Branch').map((b) => (
                <div className="assign-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={b.key}>
                  <span>{b.name}</span>
                  <span className="cell-muted" style={{ fontSize: 11.5 }}>{b.sub}</span>
                </div>
              ))}
          </div>
          <div className="panel panel-pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ fontSize: 13, margin: 0 }}>Teams</h3>
              <button className="btn btn-sm" onClick={() => setAddingTeam({ departmentId: data.departments[0]?.id || '', name: '' })}>+ Add Team</button>
            </div>
            {shown('Team').length === 0
              ? <div className="empty-mini">{none('teams')}</div>
              : shown('Team').map((t) => (
                <div className="assign-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={t.key}>
                  <span>{t.name}</span>
                  <span className="cell-muted" style={{ fontSize: 11.5 }}>{t.sub}</span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {editing && (
        <Modal
          title="Edit role"
          onClose={() => setEditing(null)}
          foot={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEdit}>Save</button>
          </>}
        >
          <div className="field"><label>Role name</label>
            <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
          <div className="field"><label>Scope / description</label>
            <input type="text" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
        </Modal>
      )}

      {addingDept !== null && (
        <Modal
          title="Add Department"
          onClose={() => setAddingDept(null)}
          foot={<>
            <button className="btn" onClick={() => setAddingDept(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={async () => {
              const ok = await run(() => api.post('/admin/departments', { name: addingDept }), 'Department added.');
              if (ok) setAddingDept(null);
            }}>Add Department</button>
          </>}
        >
          <div className="field"><label>Department name</label>
            <input type="text" value={addingDept} onChange={(e) => setAddingDept(e.target.value)} /></div>
        </Modal>
      )}

      {addingTeam && (
        <Modal
          title="Add Team"
          onClose={() => setAddingTeam(null)}
          foot={<>
            <button className="btn" onClick={() => setAddingTeam(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={async () => {
              const ok = await run(() => api.post(`/admin/departments/${addingTeam.departmentId}/teams`, { name: addingTeam.name }), 'Team added.');
              if (ok) setAddingTeam(null);
            }}>Add Team</button>
          </>}
        >
          <div className="field"><label>Department</label>
            <Combo value={addingTeam.departmentId} onChange={(e) => setAddingTeam({ ...addingTeam, departmentId: e.target.value })}>
              {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Combo></div>
          <div className="field"><label>Team name</label>
            <input type="text" value={addingTeam.name} onChange={(e) => setAddingTeam({ ...addingTeam, name: e.target.value })} /></div>
        </Modal>
      )}

      {adding && (
        <Modal
          title="Add approval level"
          onClose={() => setAdding(null)}
          foot={<>
            <button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveAdd}>Add approval level</button>
          </>}
        >
          <div className="notice" style={{ marginBottom: 10 }}>
            This adds a level to the approval &amp; escalation chain only. To create a role for employees,
            use <Link to="/admin/roles">Role Catalog → Add Role</Link>.
          </div>
          <div className="field"><label>Approval level name?</label>
            <input type="text" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
          <div className="field"><label>Scope / description?</label>
            <input type="text" value={adding.description} onChange={(e) => setAdding({ ...adding, description: e.target.value })} /></div>
        </Modal>
      )}
    </div>
  );
}

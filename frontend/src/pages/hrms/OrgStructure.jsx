import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { PanelPad, AssignRow, EmptyMini, TwoCol } from '../../components/proto.jsx';
import { isAdmin } from '../../permissions';


export default function OrgStructure() {
  const { user } = useAuth();
  const canEdit = isAdmin(user);
  const [departments, setDepartments] = useState([]);
  const [teams, setTeams] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [roles, setRoles] = useState([]);
  const [dragIdx, setDragIdx] = useState(null);
  const [saving, setSaving] = useState(null);

  function load() {
    // /admin/departments carries each department's teams, so one call feeds both panels.
    api.get('/admin/departments').then((res) => {
      setDepartments(res.data);
      setTeams(res.data.flatMap((d) => (d.teams || []).map((t) => ({ ...t, departmentName: d.name }))));
    }).catch(() => { setDepartments([]); setTeams([]); });
    api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
    api.get('/hrms/escalation').then((res) => setRoles(res.data.roles)).catch(() => setRoles([]));
  }
  useEffect(load, []);

  async function saveOrder(next) {
    setRoles(next);
    await api.put('/hrms/escalation', { roles: next }).catch(() => load());
  }

  function drop(i) {
    if (dragIdx === null || dragIdx === i) return;
    const next = [...roles];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(i, 0, moved);
    setDragIdx(null);
    saveOrder(next);
  }

  // Reporting line — main's own org tree, kept alongside the prototype's panels.
  async function setManager(id, reportingManagerId) {
    setSaving(id);
    await api.put(`/employees/${id}/manager`, { reportingManagerId: reportingManagerId || null });
    setSaving(null);
    load();
  }
  const rootNodes = employees.filter((e) => !e.reportingManagerId);
  const childrenOf = (id) => employees.filter((e) => e.reportingManagerId === id);
  function renderNode(emp, depth) {
    return (
      <div key={emp.id}>
        <AssignRow flush style={{ paddingLeft: depth * 20 }}>
          <span>{emp.name} <span className="cell-muted">({emp.designation || emp.department || '—'})</span></span>
          <select value={emp.reportingManagerId || ''} onChange={(e) => setManager(emp.id, e.target.value)} disabled={saving === emp.id} style={{ maxWidth: 200 }}>
            <option value="">No manager (top level)</option>
            {employees.filter((m) => m.id !== emp.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </AssignRow>
        {childrenOf(emp.id).map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Organization Structure</h1>
          <div className="page-sub">Departments, branches, teams and the approval escalation order</div>
        </div>
      </div>

      <TwoCol>
        <div>
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Departments</h3>
            {departments.length === 0 ? <EmptyMini>No departments yet.</EmptyMini> : departments.map((d) => (
              <AssignRow flush key={d.id}><span>{d.name}</span><span className="cell-muted">{d.parent ? `Under ${d.parent}` : 'Top-level'}</span></AssignRow>
            ))}
            <div className="small-muted" style={{ marginTop: 8 }}>Departments are added and edited in Administration → Departments &amp; Teams.</div>
          </PanelPad>
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Teams</h3>
            {teams.length === 0 ? <EmptyMini>No teams yet.</EmptyMini> : teams.map((t) => (
              <AssignRow flush key={t.id}><span>{t.name}</span><span className="cell-muted">{t.departmentName || '—'}</span></AssignRow>
            ))}
          </PanelPad>
          <PanelPad>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Reporting Line</h3>
            {employees.length === 0 ? <EmptyMini>No employees yet.</EmptyMini> : rootNodes.map((r) => renderNode(r, 0))}
          </PanelPad>
        </div>
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>Approval Escalation Order</h3>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            A leave, attendance-regularization or issue request climbs this chain top to bottom. Drag to reorder.
          </div>
          {roles.map((r, i) => (
            <AssignRow
              flush
              key={r}
              style={{ cursor: canEdit ? 'grab' : 'default' }}
            >
              <span
                draggable={canEdit}
                onDragStart={() => setDragIdx(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(i)}
                style={{ flex: 1 }}
              >
                {i + 1}. {r}
              </span>
              <span className="small-muted" onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)}>⠿ drag</span>
            </AssignRow>
          ))}
          {roles.length === 0 && <EmptyMini>No escalation chain configured.</EmptyMini>}
        </PanelPad>
      </TwoCol>
    </div>
  );
}

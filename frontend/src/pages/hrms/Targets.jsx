import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Panel, PanelHead, EmptyMini, QaRow, Modal } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';

const thisMonth = () => new Date().toISOString().slice(0, 7);

function SetTargetModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', title: '', month: thisMonth(), amount: 10, achieved: 0, unit: 'placements' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.employeeId) { setError('Pick an employee.'); return; }
    try {
      await api.post('/targets', {
        employeeId: form.employeeId,
        title: form.title || 'Monthly target',
        date: form.month,
        amount: Number(form.amount) || 0,
        achieved: Number(form.achieved) || 0,
        unit: form.unit,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not set the target');
    }
  }

  return (
    <Modal
      title="Set Monthly Target"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Save</button></>}
    >
      <div className="field">
        <label>Employee</label>
        <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
          <option value="">Select employee</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Goal</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Monthly target" /></div>
      <div className="grid-2">
        <div className="field"><label>Month</label><input type="month" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} /></div>
        <div className="field"><label>Unit</label><input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></div>
        <div className="field"><label>Target</label><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
        <div className="field"><label>Achieved</label><input type="number" value={form.achieved} onChange={(e) => setForm({ ...form, achieved: e.target.value })} /></div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function Targets() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [open, setOpen] = useState(false);

  function load() {
    api.get('/targets').then((res) => setRecords(res.data));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, [isHR]);

  async function editAchieved(r) {
    const v = prompt(`Achieved (${r.unit || 'units'}) for ${r.employee?.name}`, r.achieved ?? 0);
    if (v === null) return;
    await api.patch(`/targets/${r.id}`, { achieved: Number(v) || 0 });
    load();
  }

  return (
    <div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      <div className="page-head">
        <div><h1>Monthly Targets</h1><div className="page-sub">Recruiter &amp; BDE performance vs target</div></div>
      </div>
      {isHR && <QaRow style={{ marginBottom: 14 }}><button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Set Target</button></QaRow>}

      <Panel>
        <PanelHead title="Monthly Targets" />
        {records.length === 0 ? <EmptyMini>No targets set yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Month</th><th>Target</th><th>Achieved</th><th>Progress</th></tr></thead>
              <tbody>
                {records.map((r) => {
                  const target = Number(r.amount) || 0;
                  const achieved = Number(r.achieved) || 0;
                  const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
                  return (
                    <tr key={r.id}>
                      <td>{r.employee?.name}</td>
                      <td className="cell-muted">{r.date || '—'}</td>
                      <td className="cell-muted">{target} {r.unit || ''}</td>
                      <td className="cell-muted">
                        {achieved} {r.unit || ''}
                        {isHR && <> <button className="btn btn-sm" onClick={() => editAchieved(r)}>Edit</button></>}
                      </td>
                      <td><b>{pct}%</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {open && <SetTargetModal employees={employees} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} />}
    </div>
  );
}

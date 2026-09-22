import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Panel, PanelHead, EmptyMini, QaRow, Modal } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';

const CATEGORIES = ['Warning', 'Suspension', 'Termination', 'Other'];

function LogCaseModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', category: 'Warning', detail: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.employeeId) { setError('Pick an employee.'); return; }
    if (!form.detail.trim()) { setError('Enter a description.'); return; }
    try {
      await api.post('/disciplinary', {
        employeeId: form.employeeId,
        title: form.category,
        category: form.category,
        detail: form.detail.trim(),
        date: new Date().toISOString().slice(0, 10),
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not log the case');
    }
  }

  return (
    <Modal
      title="Log Disciplinary Case"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Save</button></>}
    >
      <div className="field">
        <label>Employee</label>
        <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
          <option value="">Select employee</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </Combo>
      </div>
      <div className="field">
        <label>Category</label>
        <Combo creatable value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </Combo>
      </div>
      <div className="field"><label>Description</label><textarea rows="3" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function Disciplinary() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageServices(user);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [open, setOpen] = useState(false);

  function load() {
    api.get('/disciplinary').then((res) => setRecords(res.data));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, [isHR]);

  async function closeCase(r) {
    await api.patch(`/disciplinary/${r.id}/status`, { status: 'Closed' });
    load();
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Disciplinary Action Tracking</h1>
          <div className="page-sub">Disciplinary action tracking — candidate/case history is never deleted</div>
        </div>
      </div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      {isHR && <QaRow style={{ marginBottom: 14 }}><button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Log Case</button></QaRow>}

      <Panel>
        <PanelHead title="Cases" />
        {records.length === 0 ? <EmptyMini>No disciplinary cases on file.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Employee</th><th>Category</th><th>Description</th><th>Raised By</th><th>Date</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>{r.employee?.name}</td>
                    <td><span className={`status ${r.category === 'Warning' ? 'pending' : r.category === 'Other' ? 'review' : 'rejected'}`}>{r.category || '—'}</span></td>
                    <td>{r.detail || '—'}</td>
                    <td className="cell-muted">{r.raisedBy || '—'}</td>
                    <td className="cell-muted">{r.date || '—'}</td>
                    <td>{r.status}</td>
                    <td>{r.status === 'Open' && isHR ? <button className="btn btn-sm" onClick={() => closeCase(r)}>Close Case</button> : <span className="small-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {open && <LogCaseModal employees={employees} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { Panel, PanelPad, PanelHead, AssignRow, EmptyMini, QaRow, Modal } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';


function LogKtModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({ topic: '', from: '', to: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const fromEmp = employees.find((e) => e.id === form.from);
    const toEmp = employees.find((e) => e.id === form.to);
    try {
      await api.post('/kt', {
        employeeId: form.from || employees[0]?.id,
        title: form.topic || '(untitled)',
        fromName: fromEmp?.name,
        toName: toEmp?.name,
        date: new Date().toISOString().slice(0, 10),
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not log the session');
    }
  }

  return (
    <Modal
      title="Log KT Session"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Save</button></>}
    >
      <div className="field"><label>Topic</label><input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} /></div>
      <div className="grid-2">
        <div className="field">
          <label>From</label>
          <select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
            <option value="">Select</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>To</label>
          <select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
            <option value="">Select</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function SubmitIdeaModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ title: '', detail: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.title.trim()) { setError('Enter a title.'); return; }
    try {
      await api.post('/weekly-ideas', { title: form.title.trim(), detail: form.detail || '—', date: new Date().toISOString().slice(0, 10) });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit the idea');
    }
  }

  return (
    <Modal
      title="Submit Weekly Idea"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Submit</button></>}
    >
      <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="field"><label>Description</label><textarea rows="3" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function KT() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [records, setRecords] = useState([]);
  const [ideas, setIdeas] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [ktOpen, setKtOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);

  function load() {
    api.get('/kt').then((res) => setRecords(res.data));
    api.get('/weekly-ideas').then((res) => setIdeas(res.data));
    api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, []);

  async function complete(r) {
    await api.patch(`/kt/${r.id}/status`, { status: 'Completed' });
    load();
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>Knowledge Transfer</h1><div className="page-sub">KT sessions, handovers and weekly idea contributions</div></div>
      </div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      <QaRow style={{ marginBottom: 14 }}><button className="btn btn-primary btn-sm" onClick={() => setKtOpen(true)}>Log KT Session</button></QaRow>

      <Panel>
        <PanelHead title="KT Sessions" />
        {records.length === 0 ? <EmptyMini>No KT sessions logged yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Topic</th><th>From</th><th>To</th><th>Date</th><th>Status</th>{isHR && <th></th>}</tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td className="cell-muted">{r.fromName || r.employee?.name || '—'}</td>
                    <td className="cell-muted">{r.toName || '—'}</td>
                    <td className="cell-muted">{r.date || '—'}</td>
                    <td><span className={`status ${r.status === 'Completed' ? 'active' : 'review'}`}>{r.status}</span></td>
                    {isHR && <td>{r.status !== 'Completed' && <button className="btn btn-sm" onClick={() => complete(r)}>Mark Completed</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <PanelPad>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Weekly Idea Contributions</h3>
          <button className="btn btn-sm btn-primary" onClick={() => setIdeaOpen(true)}>Submit Idea</button>
        </div>
        {ideas.length === 0 ? <EmptyMini>No ideas submitted yet.</EmptyMini> : ideas.map((idea) => (
          <div key={idea.id}>
            <AssignRow flush>
              <span>{idea.title}</span>
              <span className={`status ${idea.status === 'Approved' ? 'active' : idea.status === 'Rejected' ? 'rejected' : 'pending'}`}>{idea.status}</span>
            </AssignRow>
            <div className="small-muted" style={{ margin: '-4px 0 8px' }}>
              {idea.detail || '—'} · Week of {idea.date || '—'}
              {idea.aiNote ? ` · ${idea.aiNote}` : ''}
            </div>
          </div>
        ))}
      </PanelPad>

      {ktOpen && <LogKtModal employees={employees} onClose={() => setKtOpen(false)} onSaved={() => { setKtOpen(false); load(); }} />}
      {ideaOpen && <SubmitIdeaModal onClose={() => setIdeaOpen(false)} onSaved={() => { setIdeaOpen(false); load(); }} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { PanelPad, AssignRow, EmptyMini, TwoCol, QaRow, Modal } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, canManageServices } from '../../permissions';
import Combo from '../../components/Combo.jsx';

// The prototype's seeded award types (state.awardTypes, line 622 area).
const AWARD_TYPES = [
  { name: 'Above & Beyond', points: 50 },
  { name: 'Team Player', points: 30 },
];

function GiveRecognitionModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({ employeeId: '', type: AWARD_TYPES[0].name, message: '' });
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!form.employeeId) { setError('Pick someone to recognise.'); return; }
    const award = AWARD_TYPES.find((a) => a.name === form.type);
    try {
      await api.post('/recognition', {
        employeeId: form.employeeId,
        title: form.type,
        detail: form.message || '—',
        points: award ? award.points : 0,
        date: new Date().toISOString().slice(0, 10),
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the recognition');
    }
  }

  return (
    <Modal
      title="Give Recognition"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Send</button></>}
    >
      <div className="field">
        <label>To</label>
        <Combo value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
          <option value="">Select employee</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </Combo>
      </div>
      <div className="field">
        <label>Award type</label>
        <Combo value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {AWARD_TYPES.map((a) => <option key={a.name} value={a.name}>{a.name} (+{a.points} pts)</option>)}
        </Combo>
      </div>
      <div className="field"><label>Message</label><textarea rows="3" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function Recognition() {
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
    api.get('/recognition').then((res) => setRecords(res.data));
    if (isHR) api.get('/employees').then((res) => setEmployees(res.data)).catch(() => setEmployees([]));
  }
  useEffect(load, [isHR]);

  const leaderboard = {};
  records.forEach((r) => {
    const name = r.employee?.name || '—';
    leaderboard[name] = (leaderboard[name] || 0) + (Number(r.points) || 0);
  });
  const ranked = Object.entries(leaderboard).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <div className="page-head">
        <div><h1>Rewards &amp; Recognition</h1><div className="page-sub">Peer-to-peer recognition, points and the leaderboard</div></div>
      </div>
      {/* The head is hidden when this screen sits inside Performance &
          Development's tab strip, so the action lives in its own row. */}
      {isHR && <QaRow style={{ marginBottom: 14 }}><button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Give Recognition</button></QaRow>}

      <TwoCol>
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Recognition Feed</h3>
          {records.length === 0 ? <EmptyMini>No recognitions yet.</EmptyMini> : records.map((r) => (
            <div key={r.id}>
              <AssignRow flush>
                <span>{r.fromName || 'HR'} → {r.employee?.name} · {r.title} (+{r.points ?? 0})</span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{r.date || ''}</span>
              </AssignRow>
              <div className="small-muted" style={{ margin: '-4px 0 8px' }}>{r.detail || '—'}</div>
            </div>
          ))}
        </PanelPad>
        <PanelPad>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Leaderboard</h3>
          {ranked.length === 0 ? <EmptyMini>No points awarded yet.</EmptyMini> : ranked.map(([name, pts], i) => (
            <AssignRow flush key={name}><span>{i + 1}. {name}</span><b>{pts} pts</b></AssignRow>
          ))}
        </PanelPad>
      </TwoCol>

      {open && <GiveRecognitionModal employees={employees} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} />}
    </div>
  );
}

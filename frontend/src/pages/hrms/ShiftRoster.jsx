import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import SimpleRecordPage from '../../components/SimpleRecordPage.jsx';
import { isHR as hasHrmsAdmin, canManageShifts } from '../../permissions';


function ShiftPatterns() {
  const { user } = useAuth();
  // isHR here DRAWS WRITE CONTROLS, so it asks the write permission and not
  // only the read one. A Manager and an Assistant Manager are view-only (§3,
  // §4) and still hold Employee Management/view, so isHR() alone would have
  // gone on offering them every button on this screen. Both halves, because
  // the screen is an administration screen AND these are writes.
  const isHR = hasHrmsAdmin(user) && canManageShifts(user);
  const [patterns, setPatterns] = useState([]);
  const [form, setForm] = useState({ name: '', startTime: '', endTime: '' });

  function load() {
    api.get('/shift-patterns').then((res) => setPatterns(res.data));
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    await api.post('/shift-patterns', form);
    setForm({ name: '', startTime: '', endTime: '' });
    load();
  }

  async function toggle(p) {
    await api.put(`/shift-patterns/${p.id}`, { active: !p.active });
    load();
  }

  return (
    <div className="card section">
      <h3>Shift Patterns</h3>
      {patterns.map((p) => (
        <div className="kv" key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
          <span className="k">{p.name} — {p.startTime} to {p.endTime}</span>
          {isHR && <button className="btn btn-sm" onClick={() => toggle(p)}>{p.active ? 'Pause' : 'Resume'}</button>}
        </div>
      ))}
      {isHR && (
        <form className="filter-row" style={{ marginTop: 10 }} onSubmit={add}>
          <input required placeholder="Shift name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          <input required type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          <button className="btn btn-sm btn-primary" type="submit">Add Shift</button>
        </form>
      )}
    </div>
  );
}

export default function ShiftRoster() {
  return (
    <div>
      <ShiftPatterns />
      <SimpleRecordPage
        title="Roster"
        apiPath="/shift-roster"
        titleLabel="Shift"
        detailLabel="Notes"
        showDate
        dateLabel="Date"
        statuses={['Scheduled', 'Completed']}
        decisions={['Completed']}
      />
    </div>
  );
}

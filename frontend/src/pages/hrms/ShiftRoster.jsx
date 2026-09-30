import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import SimpleRecordPage from '../../components/SimpleRecordPage.jsx';
import { isHR as hasHrmsAdmin, canManageShifts } from '../../permissions';
import { ComposeModal, Field, Row, useSubmit } from '../../components/ComposeForm.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';
import { invalidateMasters } from '../../utils/masters';


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
  const [adding, setAdding] = useState(false);
  const { busy, error, setError, run } = useSubmit();

  function load() {
    api.get('/shift-patterns').then((res) => setPatterns(res.data));
  }
  useEffect(load, []);

  async function add() {
    if (!form.name.trim()) { setError('Enter a shift name.'); return; }
    if (!form.startTime || !form.endTime) { setError('Enter the start and end time.'); return; }
    const res = await run(() => api.post('/shift-patterns', form), 'Could not add the shift');
    if (!res) return;
    setForm({ name: '', startTime: '', endTime: '' });
    setAdding(false);
    invalidateMasters(); // shift patterns are a live master (the employee form's Shift list)
    load();
  }

  async function toggle(p) {
    await api.put(`/shift-patterns/${p.id}`, { active: !p.active });
    invalidateMasters();
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
        <div className="qa-row" style={{ marginTop: 10 }}>
          <button className="btn btn-sm btn-primary" onClick={() => { setError(''); setAdding(true); }}>+ Add Shift Pattern</button>
        </div>
      )}
      {adding && (
        <ComposeModal title="Add Shift Pattern" onClose={() => setAdding(false)} onSubmit={add} submitLabel="Add Shift" busy={busy} error={error}>
          <Field label="Shift name" required><input placeholder="General, Night…" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Row>
            <Field label="Start time" required><input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></Field>
            <Field label="End time" required><input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></Field>
          </Row>
        </ComposeModal>
      )}
    </div>
  );
}

export default function ShiftRoster() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div>
      <ShiftPatterns />
      {/* Data I/O: export everyone in scope / one employee, and import with
          the compulsory sample (backend src/io/shiftRoster.js). An import
          remounts the list below so the new rows show. */}
      <div className="qa-row" style={{ justifyContent: 'flex-end', margin: '0 0 10px' }}>
        <DataIoBar ioKey="shift-roster" onImported={() => setReloadKey((k) => k + 1)} />
      </div>
      <SimpleRecordPage
        key={reloadKey}
        title="Roster"
        apiPath="/shift-roster"
        // Roster a shift for one or MANY departments or named employees at
        // once (one roster row per person); an employee still logs their own.
        audience
        audienceLabel="Roster for"
        createLabel="Roster a Shift"
        aiKind="roster"
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

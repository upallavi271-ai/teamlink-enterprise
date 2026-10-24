// ---------------------------------------------------------------------------
// MARK AS EXITED / RELIEVED (founder, 2026-10-15): "For Relieved and Exited NO approvals are ever needed."
// One separate button + one small dialog for the HR desk / Internal HR / Admin / Super Admin.
//   <MarkLeftButton employee={{ id, name, employmentStatus }} onDone={() => reload()} />
// The server (POST /resignations/exit/employee/:id/relieve-now) decides; this only hides what cannot be used.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import Combo from '../Combo.jsx';

const LEFT = ['Exited', 'Relieved', 'Terminated'];
let cache = null;
let cacheAt = 0;
export function useMarkLeftOptions() {
  const [opt, setOpt] = useState(cache);
  useEffect(() => {
    if (cache && Date.now() - cacheAt < 15000) { setOpt(cache); return; }
    api.get('/resignations/exit/relieve-now/options').then((r) => { cache = r.data; cacheAt = Date.now(); setOpt(r.data); }).catch(() => setOpt({ canUse: false }));
  }, []);
  return opt;
}
const errText = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const dmy = (iso) => (iso ? iso.split('-').reverse().join('-') : '');

export function MarkLeftDialog({ employee, onClose, onDone }) {
  const opt = useMarkLeftOptions();
  const today = (opt && opt.today) || new Date().toISOString().slice(0, 10);
  const [status, setStatus] = useState('Relieved');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const day = date || today;
  const bad = day > today ? 'Pick today or an earlier date' : '';
  async function go() {
    setError('');
    if (bad) { setError(bad); return; }
    setBusy(true);
    try {
      const r = await api.post(`/resignations/exit/employee/${employee.id}/relieve-now`, { status, reason, remarks: remarks || undefined, lastWorkingDate: day });
      onDone && onDone(r.data);
      onClose();
    } catch (e) { setError(errText(e, 'That did not work. Please try again.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Mark ${employee.name} as Exited or Relieved`}
      onClose={onClose}
      footer={(<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !reason.trim() || !!bad} onClick={go}>{busy ? 'Saving…' : 'Confirm'}</button></>)}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
            <input type="radio" name="markleft-status" checked={status === 'Relieved'} onChange={() => setStatus('Relieved')} style={{ width: 'auto', marginTop: 3 }} />
            <span><b>Relieved</b><div className="small-muted">The person finished their notice or was let go properly.</div></span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="radio" name="markleft-status" checked={status === 'Exited'} onChange={() => setStatus('Exited')} style={{ width: 'auto', marginTop: 3 }} />
            <span><b>Exited</b><div className="small-muted">The person has left without finishing the usual steps (for example, stopped coming).</div></span>
          </label>
        </div>
        <label>Last working day
          <input type="date" value={day} max={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        {bad && <div className="error-text">{bad}</div>}
        <label>Reason
          <Combo creatable value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pick or type a reason">
            <option value="">Pick or type a reason</option>
            {((opt && opt.reasons) || []).map((r) => <option key={r} value={r}>{r}</option>)}
          </Combo>
        </label>
        <label>Remarks (optional)
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Anything HR should remember" />
        </label>
        <div className="notice">
          {employee.name} will be marked {status} on {dmy(day)}. They will be taken off their seat and cannot sign in after this.
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

export default function MarkLeftButton({ employee, onDone, className = 'btn btn-sm', label = 'Mark as Exited / Relieved' }) {
  const opt = useMarkLeftOptions();
  const [open, setOpen] = useState(false);
  if (!employee || !opt || !opt.canUse) return null;
  if (opt.ownEmployeeId && opt.ownEmployeeId === employee.id) return null;
  if (LEFT.includes(employee.employmentStatus)) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && <MarkLeftDialog employee={employee} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// REJOIN EMPLOYEE (founder, 2026-10-15): a relieved / exited person who came back keeps the SAME ID and the whole history.
//   <RejoinButton employee={{ id, name, employeeCode, employmentStatus }} onDone={() => reload()} />
//   <RejoinInfo employeeId={id} onChanged={() => reload()} />   "First joined ... · Rejoined ..." (+ Undo for an Admin)
// The server (POST /resignations/exit/employee/:id/rejoin, utils/rejoin.js) decides; this only hides what cannot be used.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import Combo from '../Combo.jsx';
import { useMarkLeftOptions } from './MarkLeft.jsx';

const LEFT = ['Exited', 'Relieved', 'Terminated'];
const errText = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function RejoinDialog({ employee, onClose, onDone }) {
  const [opt, setOpt] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [f, setF] = useState({ date: '', department: '', designation: '', seat: '', tlId: '', stlId: '', team: '', roleCode: '', employeeType: '', location: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const set = (p) => setF((x) => ({ ...x, ...p }));

  useEffect(() => {
    let alive = true;
    api.get(`/resignations/exit/employee/${employee.id}/rejoin/options`, { params: f.department ? { department: f.department } : {} })
      .then((r) => {
        if (!alive) return;
        setOpt(r.data);
        setF((x) => ({
          ...x,
          date: x.date || r.data.today,
          department: x.department || r.data.department || '',
          designation: x.designation || (r.data.current && r.data.current.designation) || '',
          employeeType: x.employeeType || (r.data.current && r.data.current.employeeType) || '',
          location: x.location || (r.data.current && r.data.current.location) || '',
          roleCode: x.roleCode || r.data.currentRole || '',
        }));
      })
      .catch((e) => { if (alive) setLoadError(errText(e, 'Could not open this. Please try again.')); });
    return () => { alive = false; };
  }, [employee.id, f.department]); // eslint-disable-line react-hooks/exhaustive-deps

  const minDate = opt && opt.minDate;
  const maxDate = opt && opt.maxDate;
  const dateProblem = useMemo(() => {
    if (!f.date) return 'Pick the date the person rejoined';
    if (minDate && f.date < minDate) return `Not before the last working day of the earlier stint (${nice(minDate)})`;
    if (maxDate && f.date > maxDate) return `Not more than 30 days from today (${nice(maxDate)} at the latest)`;
    return '';
  }, [f.date, minDate, maxDate]);
  const vacant = ((opt && opt.seats) || []).filter((s) => s.vacant);
  const tlList = ((opt && opt.leads) || []).filter((l) => l.role !== 'STL');
  const stlList = ((opt && opt.leads) || []).filter((l) => l.role === 'STL');
  const gapFrom = opt && opt.previousLastDay ? addDays(opt.previousLastDay, 1) : null;
  const gapTo = f.date ? addDays(f.date, -1) : null;

  async function go() {
    setError('');
    if (dateProblem) { setError(dateProblem); return; }
    setBusy(true);
    try {
      const r = await api.post(`/resignations/exit/employee/${employee.id}/rejoin`, {
        date: f.date, department: f.department, designation: f.designation || undefined, seat: f.seat || undefined,
        tlId: f.tlId || undefined, stlId: f.stlId || undefined, team: f.team || undefined, roleCode: opt && opt.hasLogin ? (f.roleCode || undefined) : undefined,
        employeeType: f.employeeType || undefined, location: f.location || undefined, remarks: f.remarks || undefined,
      });
      setResult(r.data);
      onDone && onDone(r.data);
    } catch (e) { setError(errText(e, 'That did not work. Please try again.')); } finally { setBusy(false); }
  }

  if (result) {
    return (
      <Modal title={`${employee.name} is back`} onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="notice" style={{ marginBottom: 8 }}>{result.message}</div>
        {(result.warnings || []).length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18 }}>{result.warnings.map((w) => <li key={w} className="small-muted">{w.charAt(0).toUpperCase() + w.slice(1)}</li>)}</ul>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={`Bring ${employee.name} back (rejoin)`}
      onClose={onClose}
      footer={(<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !opt || !!dateProblem || !f.department} onClick={go}>{busy ? 'Saving…' : 'Rejoin'}</button></>)}
    >
      {loadError && <div className="error-text" role="alert">{loadError}</div>}
      {!opt && !loadError && <div className="small-muted">Opening…</div>}
      {opt && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="small-muted">
            {employee.name} ({employee.employeeCode}) keeps the same ID and all the old history. {opt.previousLastDay ? `The earlier stint ended on ${nice(opt.previousLastDay)}.` : ''}
          </div>
          <label>Rejoining date
            <input type="date" value={f.date} min={minDate || undefined} max={maxDate || undefined} onChange={(e) => set({ date: e.target.value })} />
            <span className="small-muted">The day the person came back. It can be a day in the past.</span>
          </label>
          {dateProblem && <div className="error-text">{dateProblem}</div>}
          <label>Department
            <Combo value={f.department} onChange={(e) => set({ department: e.target.value, seat: '', tlId: '', stlId: '', team: '' })}>
              {opt.departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
          </label>
          <label>Designation
            <Combo creatable value={f.designation} onChange={(e) => set({ designation: e.target.value })}>
              <option value="">Keep as it was</option>
              {opt.designations.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
          </label>
          <label>Seat
            <Combo value={f.seat} onChange={(e) => set({ seat: e.target.value })}>
              <option value="">No seat yet (add it later)</option>
              {vacant.map((s) => <option key={s.code} value={s.code}>{`${s.code}${s.name ? ` · ${s.name}` : ''} · vacant`}</option>)}
            </Combo>
            <span className="small-muted">{vacant.length ? `${vacant.length} vacant seat${vacant.length === 1 ? '' : 's'} in ${f.department}.` : `No vacant seat in ${f.department} right now.`}</span>
          </label>
          <div className="grid-2">
            <label>Team lead (TL)
              <Combo value={f.tlId} onChange={(e) => set({ tlId: e.target.value })}>
                <option value="">Not decided yet</option>
                {tlList.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </Combo>
            </label>
            <label>Senior team lead (STL)
              <Combo value={f.stlId} onChange={(e) => set({ stlId: e.target.value })}>
                <option value="">None</option>
                {stlList.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </Combo>
            </label>
          </div>
          <label>Team (if the department has teams)
            <input value={f.team} onChange={(e) => set({ team: e.target.value })} placeholder="For example Team-A" />
          </label>
          <div className="grid-2">
            <label>Login role
              {opt.hasLogin ? (
                <Combo value={f.roleCode} onChange={(e) => set({ roleCode: e.target.value })}>
                  {opt.roles.map((r) => <option key={r.code} value={r.code}>{r.name || r.code}</option>)}
                </Combo>
              ) : (<input value="No login yet" disabled />)}
            </label>
            <label>Employee type
              <Combo allowCustom value={f.employeeType} onChange={(e) => set({ employeeType: e.target.value })}>
                {[...new Set([...(opt.current && opt.current.employeeType ? [opt.current.employeeType] : []), ...opt.employeeTypes])].map((t) => <option key={t} value={t}>{t}</option>)}
              </Combo>
            </label>
          </div>
          <label>Work location
            <Combo creatable value={f.location} onChange={(e) => set({ location: e.target.value })}>
              <option value="">Keep as it was</option>
              {opt.locations.map((l) => <option key={l} value={l}>{l}</option>)}
            </Combo>
          </label>
          <label>Remarks
            <input value={f.remarks} onChange={(e) => set({ remarks: e.target.value })} placeholder="Anything HR should remember" />
          </label>
          <div className="notice">
            {employee.name} becomes Active again from {nice(f.date) || 'the date above'}, in {f.department || 'the department above'}.
            {gapFrom && gapTo && gapFrom <= gapTo ? ` The days from ${nice(gapFrom)} to ${nice(gapTo)} will not be counted as absent.` : ''}
            {!opt.hasLogin ? ' This person has no login yet: make one from the profile afterwards.' : ''}
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

export default function RejoinButton({ employee, onDone, className = 'btn btn-sm btn-primary', label = 'Rejoin' }) {
  const opt = useMarkLeftOptions();
  const [open, setOpen] = useState(false);
  if (!employee || !opt || !opt.isDesk) return null;
  if (opt.ownEmployeeId && opt.ownEmployeeId === employee.id) return null;
  if (!LEFT.includes(employee.employmentStatus)) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && <RejoinDialog employee={employee} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

// "First joined 9 Aug 2025 · Rejoined 5 Oct 2026". Renders nothing for people who never rejoined (or when the viewer is not HR).
export function RejoinInfo({ employeeId, onChanged, refreshKey = 0 }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let alive = true;
    api.get(`/resignations/exit/employee/${employeeId}/rejoin/info`).then((r) => { if (alive) setInfo(r.data); }).catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, [employeeId, refreshKey]);
  if (!info || !info.rejoined) return msg ? <div className="small-muted">{msg}</div> : null;
  async function undo() {
    if (!window.confirm('Undo this rejoin? The person goes back to Relieved/Exited exactly as before. This only works before anything else is recorded since rejoining.')) return;
    setBusy(true); setMsg('');
    try { const r = await api.post(`/resignations/exit/employee/${employeeId}/rejoin/undo`); setMsg(r.data.message); setInfo(null); onChanged && onChanged(); } catch (e) { setMsg(errText(e, 'Could not undo.')); } finally { setBusy(false); }
  }
  return (
    <div className="small-muted" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span><b>{info.text}</b>{info.department ? ` · ${info.department}` : ''}</span>
      {info.canUndo && <button type="button" className="btn btn-sm" disabled={busy} onClick={undo}>Undo rejoin</button>}
      {msg && <span>{msg}</span>}
    </div>
  );
}

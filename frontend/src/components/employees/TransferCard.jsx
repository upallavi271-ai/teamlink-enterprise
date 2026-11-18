// ---------------------------------------------------------------------------
// THE TRANSFER CARD (Employee Management -> Transfer).
//
// It used to move the department and nothing else. Now it moves the PERSON: department, team, ROLE, seat and who they report to,
// and shows - before anything is saved - exactly what will change. Every dropdown is fed by the server's preview
// (POST /employees/:id/transfer with preview:true), which is also what Confirm saves, so what is shown is what happens.
//
//   * Role         the job (Recruiter, TL, BDE, Manager ...), from the designation master and Role Catalog; opens on their current role,
//                  so a plain department move leaves the role alone.
//   * Seat         the seats of the NEW department; the first vacant seat that fits the role is chosen for you (change it or pick "No seat").
//   * Reports to   shown when the department or the level of the role changes.
//   * Their team   shown when a TL / STL who leads people is being moved: hand the team to a named lead, or leave them without one on purpose.
//   * "What will change" lists every change with the old value; red = cannot be saved yet, amber = worth knowing.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import './TransferCard.css';

const FRESH = { team: '', reason: '', roleKey: undefined, seat: 'auto', reportsTo: undefined, teamMode: '', teamTo: '' };

export default function TransferCard({ employee, departments, onClose, onDone }) {
  // Opens on what the person has today, so "nothing chosen" means "nothing changes".
  const [form, setForm] = useState({ ...FRESH, department: employee.department || '', team: employee.team || '' });
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  // What the server is asked: only what the person has actually chosen (an untouched dropdown is "let the card decide").
  const payload = useMemo(() => {
    const p = { department: form.department, team: form.team, reason: form.reason, seat: form.seat };
    if (form.roleKey !== undefined) p.roleKey = form.roleKey;
    if (form.reportsTo !== undefined) p.reportsTo = form.reportsTo;
    if (form.teamMode === 'leave') p.teamMode = 'leave';
    if (form.teamMode === 'handover' && form.teamTo) p.teamTo = form.teamTo;
    return p;
  }, [form]);

  // The preview follows every change (a short pause so typing a reason is not a request per letter).
  useEffect(() => {
    const mine = seq.current + 1; seq.current = mine;
    setLoading(true);
    const t = setTimeout(() => {
      api.post(`/employees/${employee.id}/transfer`, { ...payload, preview: true })
        .then((res) => { if (seq.current === mine) { setPlan(res.data); setError(''); } })
        .catch((err) => { if (seq.current === mine) setError(err.response?.data?.error || 'Could not work out what this transfer changes.'); })
        .finally(() => { if (seq.current === mine) setLoading(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [payload, employee.id]);

  const opts = plan?.options || null;
  const teams = (departments.find((d) => d.name === form.department)?.teams) || [];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  // Changing the department or the role starts the seat / reporting line / team choices again: they depend on it.
  const resetDependents = { seat: 'auto', reportsTo: undefined, teamMode: '', teamTo: '' };

  const roleValue = form.roleKey !== undefined ? form.roleKey : (opts ? opts.currentRoleKey : '');
  const seatValue = form.seat === 'auto' ? (opts ? opts.seatSelected : '') : form.seat;
  const reportsValue = form.reportsTo !== undefined ? form.reportsTo : (opts ? opts.reportsTo.selected : 'keep');
  const team = opts?.team;
  const canConfirm = !!plan && plan.ok && !plan.noChange && !loading && !saving;

  async function confirm(e) {
    e.preventDefault();
    if (!canConfirm) return;
    setSaving(true); setError('');
    try {
      const res = await api.post(`/employees/${employee.id}/transfer`, payload);
      const lines = (res.data?.transfer?.lines || []).filter((l) => l.label !== 'Seat note').map((l) => `${l.label}: ${l.from ? `${l.from} → ` : ''}${l.to}`);
      const warns = res.data?.transfer?.warnings || [];
      onDone(`${employee.name} transferred. ${lines.join('; ')}.${warns.length ? ` Please check: ${warns.join(' ')}` : ''}`);
    } catch (err) {
      setError(err.response?.data?.error || 'The transfer could not be saved, and nothing was changed.');
      setSaving(false);
    }
  }

  return (
    <form className="card section transfer-card" onSubmit={confirm} style={{ borderColor: 'var(--warn)' }}>
      <h3>Transfer {employee.name}</h3>
      <div className="grid-2">
        <label className="field"><span>Department</span>
          <Combo
            departments creatable required value={form.department}
            onChange={(e) => set({ department: e.target.value, team: '', ...resetDependents })}
          >
            <option value="">Select department</option>
            {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </Combo></label>
        {teams.length > 0 && (
          <label className="field"><span>Team</span>
            <Combo creatable value={form.team} onChange={(e) => set({ team: e.target.value, seat: 'auto' })}>
              <option value="">No team</option>
              {teams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Combo></label>
        )}
        <label className="field"><span>Role / designation</span>
          <Combo value={roleValue} onChange={(e) => set({ roleKey: e.target.value, ...resetDependents })} disabled={!opts}>
            {!opts && <option value="">Loading…</option>}
            {(opts ? opts.roles : []).map((r) => (
              <option key={r.key} value={r.key}>{r.label}{r.key === opts.currentRoleKey && !/\(current\)/.test(r.label) ? ' (current)' : ''}</option>
            ))}
          </Combo></label>
        <label className="field"><span>Seat (position)</span>
          <Combo value={seatValue} onChange={(e) => set({ seat: e.target.value })} disabled={!opts}>
            <option value="">No seat</option>
            {(opts ? opts.seats : []).map((s) => (
              <option key={s.code} value={s.code} disabled={!s.selectable && s.code !== opts.currentSeat}>
                {`${s.code}${s.team ? ` · ${s.team}` : ''} — ${s.code === opts.currentSeat && opts.keepSeat ? 'their current seat' : (s.selectable ? (s.vacant ? 'vacant' : `${s.holder} (on notice)`) : s.why)}`}
              </option>
            ))}
          </Combo></label>
        {opts && opts.reportsTo.review && (
          <label className="field"><span>Reports to</span>
            <Combo value={reportsValue} onChange={(e) => set({ reportsTo: e.target.value })}>
              {opts.reportsTo.selected === 'keep' && <option value="keep">Keep the current reporting line</option>}
              <option value="">Nobody yet</option>
              {opts.reportsTo.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Combo>
            {!opts.reportsTo.options.length && opts.reportsTo.empty && <span className="small-muted">{opts.reportsTo.empty}</span>}
          </label>
        )}
        <label className="field"><span>Reason (optional)</span>
          <input value={form.reason} onChange={(e) => set({ reason: e.target.value })} /></label>
      </div>

      {/* A TL / STL who leads people: what happens to them is chosen here, never guessed. */}
      {team && team.needed && (
        <div className="notice amber transfer-team">
          <div>
            <strong>{employee.name} leads {team.count} {team.count === 1 ? 'person' : 'people'} in {team.department}</strong>
            <div className="small-muted">{team.people.map((p) => p.name).join(', ')}</div>
            <label className="transfer-radio">
              <input type="radio" name="teamMode" checked={form.teamMode === 'handover'} onChange={() => set({ teamMode: 'handover' })} disabled={!team.candidates.length} />
              <span>Hand their team to</span>
              <Combo value={form.teamTo} onChange={(e) => set({ teamMode: 'handover', teamTo: e.target.value })} disabled={!team.candidates.length}>
                <option value="">{team.candidates.length ? 'Choose a lead…' : `No other lead in ${team.department}`}</option>
                {team.candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Combo>
            </label>
            <label className="transfer-radio">
              <input type="radio" name="teamMode" checked={form.teamMode === 'leave'} onChange={() => set({ teamMode: 'leave', teamTo: '' })} />
              <span>Leave them without a lead for now (I will set one later)</span>
            </label>
          </div>
        </div>
      )}

      {/* WHAT WILL CHANGE - the confirmation. */}
      <div className="transfer-plan" aria-live="polite">
        {error && <div className="notice red">{error}</div>}
        {plan && plan.blockers.length > 0 && (
          <div className="notice red"><ul>{plan.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>
        )}
        {plan && plan.ok && plan.noChange && !loading && (
          <div className="small-muted">Nothing changes yet. Choose a different department, team, role or seat.</div>
        )}
        {plan && plan.lines.length > 0 && (
          <div className="transfer-lines">
            <div className="small-muted"><strong>If you confirm, this changes{loading ? ' …' : ''}</strong></div>
            <table className="table">
              <tbody>
                {plan.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="cell-muted transfer-label">{l.label}</td>
                    <td>{l.from ? <><span className="transfer-from">{l.from}</span> <span aria-hidden="true">→</span> </> : null}<strong>{l.to}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small-muted">The login, seat history, Vacancies and the Employee History tab follow by themselves.</div>
          </div>
        )}
        {plan && plan.warnings.length > 0 && (
          <div className="notice amber"><ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
        )}
      </div>

      <button className="btn btn-primary btn-sm" type="submit" disabled={!canConfirm}>{saving ? 'Saving…' : 'Confirm Transfer'}</button>{' '}
      <button className="btn btn-sm" type="button" onClick={onClose}>Cancel</button>
    </form>
  );
}

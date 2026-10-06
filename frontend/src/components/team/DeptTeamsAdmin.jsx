import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { FacetSelect, useLocalFacets } from '../ui/ListPageHeader.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import '../followups/followups.css';

// ---------------------------------------------------------------------------
// DEPARTMENTS & TEAMS (ATS change list §13, Admin): give a TL or STL one or
// more departments, and move a recruiter to another department — with the
// history of who was where and when.
//
// Read: GET /api/ats-daily/org (Super Admin / Admin). Writes are the EXISTING
// audited endpoints, so nothing here keeps a second copy of the org:
//   TL / STL departments   PUT  /employees/management/:employeeId/scope
//   move a recruiter       POST /employees/:employeeId/transfer   (department;
//                          the login's ATS area follows)
//                          POST /positions/:seatId/assign         (new seat; the
//                          old seat's tenure ends the day before — seats are
//                          permanent, utils/positionScope.js)
//                          POST /positions/:oldSeatId/vacate      (no new seat)
// ---------------------------------------------------------------------------

const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayBefore = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const when = (at) => new Date(at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const FIELDS = [{ key: 'department', get: (r) => r.dept }];

function MoveForm({ person, data, onDone, onCancel }) {
  const [dept, setDept] = useState('');
  const [seat, setSeat] = useState('');
  const [from, setFrom] = useState(todayIst());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const seats = data.emptySeats.filter((s) => s.department === dept);
  async function move() {
    setErr('');
    if (!dept) { setErr('Pick the new department.'); return; }
    if (!person.employeeId) { setErr(`${person.name} has no employee record, so the move cannot be saved.`); return; }
    if (seats.length && !seat) { setErr('Pick the seat they will sit in.'); return; }
    setBusy(true);
    try {
      await api.post(`/employees/${person.employeeId}/transfer`, { department: dept, reason: reason || 'Moved in Recruiter & BDE → Departments & teams' });
      if (seat) {
        await api.post(`/positions/${seat}/assign`, { employeeId: person.employeeId, fromDate: from, note: reason || null });
      } else if (person.seat && person.seat.department !== dept) {
        const to = from > person.seat.since ? dayBefore(from) : person.seat.since;
        await api.post(`/positions/${person.seat.id}/vacate`, { toDate: to, note: reason || `Moved to ${dept}` });
      }
      onDone(`Saved — ${person.name} moved to ${dept}${seat ? ` (${(seats.find((s) => s.id === seat) || {}).code})` : ''}. The old seat stays in the history.`);
    } catch (e) {
      setErr(e.response?.data?.error || 'The move could not be saved. Please try again.');
    } finally { setBusy(false); }
  }
  return (
    <div className="fux-target" style={{ marginTop: 8 }}>
      <div className="fux-dr-bar" style={{ marginBottom: 6 }}>
        <div className="field">
          <label htmlFor={`mv-dept-${person.userId}`}>New department</label>
          <select id={`mv-dept-${person.userId}`} value={dept} onChange={(e) => { setDept(e.target.value); setSeat(''); }}>
            <option value="">Choose…</option>
            {data.departments.filter((d) => d !== person.department).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        {dept && (
          <div className="field">
            <label htmlFor={`mv-seat-${person.userId}`}>Seat</label>
            {seats.length ? (
              <select id={`mv-seat-${person.userId}`} value={seat} onChange={(e) => setSeat(e.target.value)}>
                <option value="">Choose an empty seat…</option>
                {seats.map((s) => <option key={s.id} value={s.id}>{s.code}{s.team ? ` · ${s.team}` : ''}</option>)}
              </select>
            ) : <div className="fux-note" style={{ marginTop: 6 }}>No empty seat in {dept} — they move without a seat. Add one in Administration → Positions.</div>}
          </div>
        )}
        <div className="field">
          <label htmlFor={`mv-from-${person.userId}`}>From</label>
          <input id={`mv-from-${person.userId}`} type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={`mv-why-${person.userId}`}>Reason (optional)</label>
          <input id={`mv-why-${person.userId}`} value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Medical needs more people" />
        </div>
      </div>
      <div className="fux-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={move}>{busy ? 'Moving…' : `Move ${person.name.split(' ')[0]}`}</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="fux-err">{err}</div>}
    </div>
  );
}

export default function DeptTeamsAdmin() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(null); // { text, undo? }
  const [busy, setBusy] = useState('');
  const [moving, setMoving] = useState('');
  const [values, setValues] = useState({ department: '' });
  const load = () => api.get('/ats-daily/org').then((r) => setData(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load departments and teams.'));
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => (data ? [
    ...data.leads.map((l) => ({ ...l, kind: 'lead', dept: [...new Set([l.homeDepartment, ...l.departments].filter(Boolean))] })),
    ...data.recruiters.map((r) => ({ ...r, kind: 'recruiter', dept: r.department })),
  ] : []), [data]);
  const facets = useLocalFacets(rows, FIELDS, values);
  const inDept = (r) => !values.department || (Array.isArray(r.dept) ? r.dept.includes(values.department) : r.dept === values.department);

  if (err) return <div className="fux-err">{err}</div>;
  if (!data) return <div className="small-muted">Loading departments and teams…</div>;

  async function setDepartments(lead, next, { undo = false } = {}) {
    if (!lead.employeeId) { setMsg({ text: `${lead.name} has no employee record, so departments cannot be saved.`, bad: true }); return; }
    setBusy(lead.userId);
    const before = lead.departments;
    try {
      await api.put(`/employees/management/${lead.employeeId}/scope`, { atsScopeDepartments: next.join(',') });
      await load();
      setMsg(undo ? { text: 'Undone.' } : {
        text: `Saved — ${lead.name} now looks after ${next.length ? next.join(', ') : 'their own department only'}.`,
        undo: () => setDepartments({ ...lead, departments: next }, before, { undo: true }),
      });
    } catch (e) {
      setMsg({ text: e.response?.data?.error || 'Could not save. Please try again.', bad: true });
    } finally { setBusy(''); }
  }

  const leads = rows.filter((r) => r.kind === 'lead' && inDept(r));
  const recruiters = rows.filter((r) => r.kind === 'recruiter' && inDept(r));
  return (
    <div className="fux-org">
      <div className="fux-dr-bar">
        <FacetSelect label="Department" value={values.department} allLabel="All departments" options={facets.department} onChange={(v) => setValues({ department: v })} />
      </div>
      {msg && (
        <div className={msg.bad ? 'fux-err' : 'fux-saved'} style={{ marginBottom: 10 }}>
          {msg.text}{' '}
          {msg.undo && <button type="button" className="btn btn-sm" onClick={() => { const u = msg.undo; setMsg(null); u(); }}>Undo</button>}
        </div>
      )}

      <div className="fux-section-title">Team leads — which departments they look after</div>
      {!leads.length ? <div className="small-muted">No TL or STL in this department.</div> : (
        <div className="fux-table-wrap">
          <table className="fux-table">
            <thead><tr><th>Name</th><th>Role</th><th>Own department</th><th>Also looks after</th><th>Add a department</th></tr></thead>
            <tbody>
              {leads.map((l) => {
                const extra = l.departments.filter((d) => d !== l.homeDepartment);
                const addable = data.departments.filter((d) => !l.departments.includes(d) && d !== l.homeDepartment);
                return (
                  <tr key={l.userId}>
                    <td><b>{l.name}</b>{l.seat && <div className="fux-note" style={{ marginTop: 0 }}>Seat {l.seat.code}</div>}</td>
                    <td>{l.role === 'STL' ? 'Senior TL' : 'TL'}</td>
                    <td>{l.homeDepartment || '—'}</td>
                    <td>
                      {extra.length ? (
                        <span className="fux-chips">
                          {extra.map((d) => (
                            <span className="fux-chip" key={d}>
                              {d}
                              <button type="button" aria-label={`Remove ${d}`} title={`Remove ${d}`} disabled={busy === l.userId} onClick={() => setDepartments(l, l.departments.filter((x) => x !== d))}>×</button>
                            </span>
                          ))}
                        </span>
                      ) : <span className="cell-muted">Only their own</span>}
                    </td>
                    <td>
                      <select
                        aria-label={`Add a department for ${l.name}`}
                        value=""
                        disabled={busy === l.userId || !addable.length}
                        onChange={(e) => e.target.value && setDepartments(l, [...new Set([...(l.departments.length ? l.departments : [l.homeDepartment].filter(Boolean)), e.target.value])])}
                      >
                        <option value="">{addable.length ? 'Add…' : 'All added'}</option>
                        {addable.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="fux-section-title">Recruiters — move to another department</div>
      {!recruiters.length ? <div className="small-muted">No recruiter in this department.</div> : (
        <div className="fux-table-wrap">
          <table className="fux-table">
            <thead><tr><th>Name</th><th>Department</th><th>Seat</th><th /></tr></thead>
            <tbody>
              {recruiters.map((r) => (
                <tr key={r.userId}>
                  <td colSpan={moving === r.userId ? 4 : 1}>
                    <b>{r.name}</b>
                    {moving === r.userId && (
                      <MoveForm
                        person={r}
                        data={data}
                        onCancel={() => setMoving('')}
                        onDone={(text) => { setMoving(''); setMsg({ text }); load(); }}
                      />
                    )}
                  </td>
                  {moving !== r.userId && (
                    <>
                      <td>{r.department || '—'}</td>
                      <td>{r.seat ? <>{r.seat.code} <span className="fux-note">since {r.seat.since}</span></> : <StatusChip tone="amber">No seat</StatusChip>}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => { setMoving(r.userId); setMsg(null); }}>Move</button></td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="fux-section-title">History — who was where</div>
      {!data.history.length ? <div className="small-muted">No moves recorded yet.</div> : (
        <div className="fux-table-wrap">
          <table className="fux-table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th><th>To</th><th>By</th></tr></thead>
            <tbody>
              {data.history.slice(0, 40).map((h, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={i}>
                  <td className="cell-muted">{when(h.at)}</td>
                  <td>{h.who || '—'}</td>
                  <td>{h.what}</td>
                  <td className="cell-muted">{h.from || '—'}</td>
                  <td>{h.to || '—'}</td>
                  <td className="cell-muted">{h.by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="fux-note">{data.note} Each seat&apos;s full history is in Administration → Positions → Seat History.</div>
    </div>
  );
}

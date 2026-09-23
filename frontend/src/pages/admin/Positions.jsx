// ---------------------------------------------------------------------------
// POSITIONS — the seats, who has sat in them, and what was done from them.
//
// MED-1, MED-2, Non IT-03, Edu BDE 1. A position is a DESK, and it outlives
// the person at it: when the holder resigns and somebody else takes over, the
// seat keeps its work history and the new holder starts adding to it.
//
// The screen answers the three questions that matter, and they are three
// different questions:
//
//   what has this SEAT done      the work list, with who did each thing
//   who has held it, and when    the tenure list, including any vacant gaps
//   what is this person's past   every seat they have held, on their row
//
// Work is attributed by the SNAPSHOTTED CODE the server stamped at the time,
// not by a join to whoever holds the seat now — so a follow-up made under
// MED-1 in March still reads as MED-1 work after the desk changes hands.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function Positions() {
  const { user } = useAuth();
  const mayManage = can(user, 'hrms', 'hrms', 'Employee Management', 'configure');

  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [filters, setFilters] = useState({ search: '', department: '', state: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', department: '', team: '', notes: '' });

  const [assigning, setAssigning] = useState(null);   // the position being staffed
  const [assignForm, setAssignForm] = useState({ employeeId: '', fromDate: today(), note: '' });

  const [detail, setDetail] = useState(null);         // the opened seat
  const [detailTab, setDetailTab] = useState('tenures');

  function load() {
    api.get('/positions').then((r) => setRows(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load positions.'));
  }
  useEffect(() => {
    load();
    api.get('/employees').then((r) => setEmployees(r.data || [])).catch(() => setEmployees([]));
  }, []);

  const departments = useMemo(
    () => [...new Set(rows.map((p) => p.department).filter(Boolean))].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return rows.filter((p) => {
      if (q && !`${p.code} ${p.name || ''} ${p.holder ? p.holder.name : ''}`.toLowerCase().includes(q)) return false;
      if (filters.department && p.department !== filters.department) return false;
      if (filters.state === 'vacant' && !p.vacant) return false;
      if (filters.state === 'filled' && p.vacant) return false;
      if (filters.state === 'retired' && p.active) return false;
      return true;
    });
  }, [rows, filters]);
  const paged = usePaged(filtered);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/positions', form);
      setNotice(`Position ${form.code} created.`);
      setForm({ code: '', name: '', department: '', team: '', notes: '' });
      setShowNew(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not create that position.'); }
  }

  async function assign(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post(`/positions/${assigning.id}/assign`, assignForm);
      setNotice(`${employees.find((x) => x.id === assignForm.employeeId)?.name || 'Employee'} now holds ${assigning.code}.`);
      setAssigning(null);
      setAssignForm({ employeeId: '', fromDate: today(), note: '' });
      load();
      return r;
    } catch (err) { setError(err.response?.data?.error || 'Could not assign that position.'); }
    return undefined;
  }

  async function vacate(p) {
    setError('');
    try {
      await api.post(`/positions/${p.id}/vacate`, { toDate: today() });
      setNotice(`${p.code} is now vacant.`);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not vacate that position.'); }
  }

  async function open(p) {
    setDetailTab('tenures');
    try {
      const r = await api.get(`/positions/${p.id}`);
      setDetail(r.data);
    } catch (err) { setError(err.response?.data?.error || 'Could not open that position.'); }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Positions</h1>
          <div className="page-sub">
            The seats — MED-1, Non IT-03, EDU BDE 1. A position outlives the person in it: when somebody
            leaves, the seat keeps its work history and the next holder carries on from it.
          </div>
        </div>
        {mayManage && <button className="btn btn-primary" onClick={() => { setError(''); setShowNew(true); }}>Add Position</button>}
      </div>

      {error && <div className="notice red">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="filter-row">
        <input
          type="text"
          placeholder="Search code, name or holder…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        />
        <Combo value={filters.department} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))}>
          <option value="">Filled or vacant</option>
          <option value="filled">Filled</option>
          <option value="vacant">Vacant</option>
          <option value="retired">Retired</option>
        </Combo>
      </div>

      <div className="tbl-wrap tbl-fit">
        <table>
          <thead>
            <tr>
              <th>Position</th><th>Name</th><th>Department</th><th>Current Holder</th>
              <th>Held Since</th><th>People</th><th>Work From This Seat</th><th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((p) => (
              <tr key={p.id} className="row-link" onClick={() => open(p)}>
                <td><b>{p.code}</b></td>
                <td className="cell-muted">{p.name || '—'}</td>
                <td className="cell-muted">{p.department || '—'}</td>
                <td>
                  {p.holder
                    ? p.holder.name
                    : <span className="status pending">Vacant</span>}
                </td>
                <td className="cell-muted">{p.holder ? fmt(p.holder.since) : '—'}</td>
                <td className="cell-muted">{p.tenureCount}</td>
                <td className="cell-muted">
                  {`${p.work.requirements} req · ${p.work.stageMoves} moves · ${p.work.followUps} follow-ups`}
                </td>
                <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                  {mayManage && (
                    <>
                      <button className="btn btn-sm" onClick={() => { setError(''); setAssigning(p); setAssignForm({ employeeId: '', fromDate: today(), note: '' }); }}>
                        {p.vacant ? 'Assign' : 'Hand over'}
                      </button>
                      {!p.vacant && <button className="btn btn-sm btn-ghost" onClick={() => vacate(p)}>Vacate</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>
                {rows.length ? 'No positions match these filters.' : 'No positions yet. Add one for each recruiting seat — MED-1, MED-2, Non IT-03 — then assign the person who sits in it.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={paged} noun="positions" />

      {/* --- Add ------------------------------------------------------- */}
      {showNew && (
        <Modal
          title="Add Position"
          onClose={() => setShowNew(false)}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setShowNew(false)}>Cancel</button>
              <button className="btn btn-primary" type="submit" form="newPositionForm">Create</button>
            </>
          )}
        >
          <form id="newPositionForm" onSubmit={create}>
            <label className="field">
              <span>Position code *</span>
              <input
                required
                placeholder="MED-1"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              />
            </label>
            <div className="small-muted" style={{ marginTop: -6, marginBottom: 10 }}>
              This code is stamped onto every requirement, stage move and follow-up made from the seat,
              so it cannot be changed later. Retire the position and create a new one instead.
            </div>
            <label className="field">
              <span>Name</span>
              <input placeholder="Medical Recruiter 1" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <div className="grid-2">
              <label className="field">
                <span>Department</span>
                <input value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
              </label>
              <label className="field">
                <span>Team</span>
                <input value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))} />
              </label>
            </div>
            <label className="field">
              <span>Notes</span>
              <textarea rows="2" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </label>
          </form>
        </Modal>
      )}

      {/* --- Assign / hand over --------------------------------------- */}
      {assigning && (
        <Modal
          title={assigning.vacant ? `Assign ${assigning.code}` : `Hand over ${assigning.code}`}
          onClose={() => setAssigning(null)}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setAssigning(null)}>Cancel</button>
              <button className="btn btn-primary" type="submit" form="assignForm">
                {assigning.vacant ? 'Assign' : 'Hand over'}
              </button>
            </>
          )}
        >
          <form id="assignForm" onSubmit={assign}>
            {!assigning.vacant && (
              <div className="notice amber">
                {`${assigning.holder.name} currently holds ${assigning.code}. Their tenure ends on the date below and the new holder's begins the same day, so the seat has exactly one occupant at any moment. Everything they did stays on this seat.`}
              </div>
            )}
            <label className="field">
              <span>Employee *</span>
              <Combo
                required
                value={assignForm.employeeId}
                onChange={(e) => setAssignForm((f) => ({ ...f, employeeId: e.target.value }))}
              >
                <option value="">— Select —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {`${e.name}${e.employeeCode ? ` (${e.employeeCode})` : ''}${e.department ? ` — ${e.department}` : ''}`}
                  </option>
                ))}
              </Combo>
            </label>
            <label className="field">
              <span>From date</span>
              <input type="date" value={assignForm.fromDate} onChange={(e) => setAssignForm((f) => ({ ...f, fromDate: e.target.value }))} />
            </label>
            <label className="field">
              <span>Note</span>
              <input placeholder="Replacing X, who resigned" value={assignForm.note} onChange={(e) => setAssignForm((f) => ({ ...f, note: e.target.value }))} />
            </label>
          </form>
        </Modal>
      )}

      {/* --- One seat: tenures and work ------------------------------- */}
      {detail && (
        <Modal
          title={`${detail.position.code}${detail.position.name ? ` — ${detail.position.name}` : ''}`}
          size="wide"
          onClose={() => setDetail(null)}
          footer={<button className="btn" type="button" onClick={() => setDetail(null)}>Close</button>}
        >
          <div className="tabs" style={{ marginBottom: 12 }}>
            <div className={`tab${detailTab === 'tenures' ? ' active' : ''}`} onClick={() => setDetailTab('tenures')}>
              {`Who has held it (${detail.tenures.filter((t) => !t.vacant).length})`}
            </div>
            <div className={`tab${detailTab === 'work' ? ' active' : ''}`} onClick={() => setDetailTab('work')}>
              {`Work from this seat (${detail.totals.requirements + detail.totals.stageMoves + detail.totals.followUps})`}
            </div>
          </div>

          {detailTab === 'tenures' && (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Person</th><th>From</th><th>To</th><th>Days</th><th>Note</th></tr></thead>
                <tbody>
                  {detail.tenures.map((t, i) => (t.vacant
                    ? (
                      <tr key={`v${i}`}>
                        <td colSpan="5" className="small-muted" style={{ fontStyle: 'italic' }}>
                          {`Vacant — ${fmt(t.fromDate)} to ${fmt(t.toDate)} (${t.days} days)`}
                        </td>
                      </tr>
                    )
                    : (
                      <tr key={t.assignmentId}>
                        <td>
                          <b>{t.employeeName}</b>
                          {t.current && <span className="status active" style={{ marginLeft: 8 }}>Current</span>}
                          {t.employeeCode && <div className="small-muted">{t.employeeCode}</div>}
                        </td>
                        <td className="cell-muted">{fmt(t.fromDate)}</td>
                        <td className="cell-muted">{t.toDate ? fmt(t.toDate) : '—'}</td>
                        <td className="cell-muted">{t.days}</td>
                        <td className="cell-muted">{t.note || '—'}</td>
                      </tr>
                    )))}
                  {!detail.tenures.length && (
                    <tr><td colSpan="5" className="small-muted" style={{ padding: 14 }}>Nobody has held this position yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {detailTab === 'work' && (
            <>
              <div className="notice">
                Attributed by the position code stamped on each record when it was made — so everything done
                from this seat stays here, whoever was sitting in it at the time.
              </div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>What</th><th>Detail</th><th>By whom</th><th>When</th></tr></thead>
                  <tbody>
                    {detail.work.requirements.map((r) => (
                      <tr key={`r${r.id}`}>
                        <td><span className="status new">Requirement</span></td>
                        <td>{`${r.reqCode || ''} ${r.title}`}<div className="small-muted">{r.client?.name}</div></td>
                        <td className="cell-muted">{r.byWhom || '—'}</td>
                        <td className="cell-muted">{fmt(String(r.createdAt).slice(0, 10))}</td>
                      </tr>
                    ))}
                    {detail.work.stageEvents.map((e) => (
                      <tr key={`e${e.id}`}>
                        <td><span className="status interview">Stage move</span></td>
                        <td>{e.action}<div className="small-muted">{`${e.candidate?.name || ''}${e.clientName ? ` · ${e.clientName}` : ''}`}</div></td>
                        <td className="cell-muted">{e.byWhom || '—'}</td>
                        <td className="cell-muted">{fmt(String(e.createdAt).slice(0, 10))}</td>
                      </tr>
                    ))}
                    {detail.work.followUps.map((f) => (
                      <tr key={`f${f.id}`}>
                        <td><span className="status review">Follow-up</span></td>
                        <td>{f.nextAction || f.outcome || 'Follow-up'}<div className="small-muted">{f.completedAt ? 'Completed' : `Due ${fmt(f.dueDate)}`}</div></td>
                        <td className="cell-muted">{f.byWhom || '—'}</td>
                        <td className="cell-muted">{fmt(String(f.createdAt).slice(0, 10))}</td>
                      </tr>
                    ))}
                    {!detail.totals.requirements && !detail.totals.stageMoves && !detail.totals.followUps && (
                      <tr><td colSpan="4" className="small-muted" style={{ padding: 14 }}>
                        Nothing has been recorded from this seat yet. Work is stamped with the position from the
                        moment somebody holds it.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

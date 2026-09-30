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
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import PositionsTree from './PositionsTree.jsx';
import SeatHistory from '../../components/SeatHistory.jsx';
import { useSearchParams } from 'react-router-dom';

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function Positions() {
  const { user } = useAuth();
  const mayManage = can(user, 'hrms', 'hrms', 'Employee Management', 'configure');

  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', department: '', team: '', kind: 'RECRUITER', notes: '' });
  // Structure (tree) or the flat list. The tree is the org structure the ATS
  // scope is built from; the list is every seat, filterable.
  // ?tab=history opens Seat History (the old HRMS → Positions & Seat History
  // link redirects here); ?tab=list the flat list.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const view = ['tree', 'list', 'history'].includes(tabParam) ? tabParam : 'tree';
  const setView = (v) => setSearchParams(v === 'tree' ? {} : { tab: v }, { replace: true });
  const [reloadKey, setReloadKey] = useState(0);

  const [assigning, setAssigning] = useState(null);   // the position being staffed
  const [assignForm, setAssignForm] = useState({ employeeId: '', fromDate: today(), note: '', endOtherSeats: true });

  const [detail, setDetail] = useState(null);         // the opened seat
  const [detailTab, setDetailTab] = useState('tenures');

  function load() {
    setReloadKey((k) => k + 1);
    api.get('/positions').then((r) => setRows(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load positions.'));
  }
  useEffect(() => {
    load();
    api.get('/employees').then((r) => setEmployees(r.data || [])).catch(() => setEmployees([]));
  }, []);

  // THE FILTER STANDARD (components/ui/ListFilters.jsx): Search · Department
  // · Status on screen; Kind · Team · Held since under More Filters; Sort.
  const work = (p) => (p.work ? p.work.requirements + p.work.stageMoves + p.work.followUps : 0);
  const lf = useListFilters(rows, [
    { key: 'q', type: 'search', placeholder: 'Search code, name or holder…',
      get: (p) => `${p.code} ${p.name || ''} ${p.holder ? `${p.holder.name} ${p.holder.employeeCode || ''}` : ''}` },
    { key: 'department', label: 'Department', allLabel: 'All departments', primary: true, get: (p) => p.department },
    { key: 'state', label: 'Status', allLabel: 'Filled or vacant', primary: true,
      options: [{ value: 'filled', label: 'Filled' }, { value: 'vacant', label: 'Vacant' }, { value: 'retired', label: 'Retired' }],
      match: (p, v) => (v === 'vacant' ? p.vacant : v === 'filled' ? !p.vacant : !p.active) },
    { key: 'kind', label: 'Kind', allLabel: 'All kinds', get: (p) => p.kind,
      options: [{ value: 'RECRUITER', label: 'Recruiter' }, { value: 'TL', label: 'TL' }, { value: 'STL', label: 'STL' }, { value: 'OTHER', label: 'Other' }] },
    { key: 'team', label: 'Team', allLabel: 'All teams', get: (p) => p.team },
    { key: 'since', type: 'daterange', label: 'Held since', get: (p) => (p.holder ? p.holder.since : '') },
  ], {
    sorts: [
      { key: 'dept', label: 'Department, code', cmp: (a, b) => String(a.department || '~').localeCompare(String(b.department || '~')) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }) },
      { key: 'code', label: 'Code A–Z', cmp: (a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }) },
      { key: 'work', label: 'Most work', cmp: (a, b) => work(b) - work(a) },
      { key: 'since', label: 'Held since (newest)', cmp: (a, b) => String(b.holder?.since || '').localeCompare(String(a.holder?.since || '')) },
    ],
  });
  const filtered = lf.rows;
  const paged = usePaged(filtered);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/positions', form);
      setNotice(`Position ${form.code} created.`);
      setForm({ code: '', name: '', department: '', team: '', kind: 'RECRUITER', notes: '' });
      setShowNew(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not create that position.'); }
  }

  async function assign(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post(`/positions/${assigning.id}/assign`, assignForm);
      const who = employees.find((x) => x.id === assignForm.employeeId)?.name || 'Employee';
      const ended = (r.data?.closed || []).map((c) => `${c.name || 'previous holder'} on ${c.code} (to ${fmt(c.toDate)})`);
      setNotice(`${who} holds ${assigning.code} from ${fmt(assignForm.fromDate)}.${ended.length ? ` Ended: ${ended.join('; ')}. Their past work stays attributed to them.` : ''}`);
      setAssigning(null);
      setAssignForm({ employeeId: '', fromDate: today(), note: '', endOtherSeats: true });
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
          <h1>Positions &amp; Seat History</h1>
          <div className="page-sub">
            The seats — MED-1, Non IT-03, EDU BDE 1. A position outlives the person in it: when somebody
            leaves, the seat keeps its work history and the next holder carries on from it.
          </div>
        </div>
        {mayManage && <button className="btn btn-primary" onClick={() => { setError(''); setShowNew(true); }}>Add Position</button>}
      </div>

      {error && <div className="notice red">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="tabs" style={{ marginBottom: 12 }}>
        <div className={`tab${view === 'tree' ? ' active' : ''}`} onClick={() => setView('tree')}>Structure</div>
        <div className={`tab${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>All positions</div>
        <div className={`tab${view === 'history' ? ' active' : ''}`} onClick={() => setView('history')}>Seat History</div>
      </div>

      {view === 'history' && <SeatHistory />}

      {view === 'tree' && (
        <PositionsTree
          mayManage={mayManage}
          reloadKey={reloadKey}
          onOpen={open}
          onAssign={(p) => { setError(''); setAssigning(p); setAssignForm({ employeeId: '', fromDate: today(), note: '', endOtherSeats: true }); }}
        />
      )}

      {view === 'list' && (<>
      <ListFilterBar lf={lf} storageKey="admin-positions" noun="positions" />

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
                      <button className="btn btn-sm" onClick={() => { setError(''); setAssigning(p); setAssignForm({ employeeId: '', fromDate: today(), note: '', endOtherSeats: true }); }}>
                        {p.vacant ? 'Assign' : 'Assign new person'}
                      </button>
                      {!p.vacant && <button className="btn btn-sm btn-ghost" onClick={() => vacate(p)}>Vacate</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan="8">
                <ListEmpty
                  lf={lf}
                  noun="positions"
                  hint="Add one for each recruiting seat — MED-1, MED-2, Non IT-03 — then assign the person who sits in it."
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={paged} noun="positions" />
      </>)}

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
              <span>Kind</span>
              <Combo value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
                <option value="RECRUITER">Recruiter</option>
                <option value="TL">TL</option>
                <option value="STL">STL</option>
                <option value="OTHER">Other (BDE, HR, …)</option>
              </Combo>
            </label>
            <div className="small-muted" style={{ marginTop: -6, marginBottom: 10 }}>
              Set which TL it reports to from the Structure tab (Edit on the seat).
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
          title={assigning.vacant ? `Assign ${assigning.code}` : `Assign new person to ${assigning.code}`}
          onClose={() => setAssigning(null)}
          footer={(
            <>
              <button className="btn" type="button" onClick={() => setAssigning(null)}>Cancel</button>
              <button className="btn btn-primary" type="submit" form="assignForm">
                {assigning.vacant ? 'Assign' : 'Assign new person'}
              </button>
            </>
          )}
        >
          <form id="assignForm" onSubmit={assign}>
            {!assigning.vacant && (
              <div className="notice amber">
                {`${assigning.holder.name} currently holds ${assigning.code}. Their tenure ends the day before the date below and the new person's starts on it, so the seat has exactly one holder on any day. ${assigning.holder.name} is not removed from the system, and everything they did from this seat stays attributed to them; work from the date below belongs to the new person.`}
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
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={assignForm.endOtherSeats}
                onChange={(e) => setAssignForm((f) => ({ ...f, endOtherSeats: e.target.checked }))}
              />
              <span>End the seat this person holds now (they move here from the date above)</span>
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

          {detailTab === 'work' && <SeatWork detail={detail} />}
        </Modal>
      )}
    </div>
  );
}

// The "Work from this seat" tab: requirements, stage moves and follow-ups in
// one list, with the filter standard (Search · Type · By whom · Date range).
function SeatWork({ detail }) {
  const items = [
    ...detail.work.requirements.map((r) => ({
      key: `r${r.id}`, type: 'Requirement', badge: 'new', title: `${r.reqCode || ''} ${r.title}`,
      sub: r.client?.name || '', byWhom: r.byWhom, createdAt: r.createdAt,
    })),
    ...detail.work.stageEvents.map((e) => ({
      key: `e${e.id}`, type: 'Stage move', badge: 'interview', title: e.action,
      sub: `${e.candidate?.name || ''}${e.clientName ? ` · ${e.clientName}` : ''}`, byWhom: e.byWhom, createdAt: e.createdAt,
    })),
    ...detail.work.followUps.map((fu) => ({
      key: `f${fu.id}`, type: 'Follow-up', badge: 'review', title: fu.nextAction || fu.outcome || 'Follow-up',
      sub: fu.completedAt ? 'Completed' : `Due ${fmt(fu.dueDate)}`, byWhom: fu.byWhom, createdAt: fu.createdAt,
    })),
  ];
  const lf = useListFilters(items, [
    { key: 'q', type: 'search', placeholder: 'Search detail or person…', get: (w) => `${w.title} ${w.sub} ${w.byWhom || ''}` },
    { key: 'type', label: 'Type', allLabel: 'All types', primary: true, get: (w) => w.type },
    { key: 'by', label: 'By whom', allLabel: 'Everyone', primary: true, get: (w) => w.byWhom },
    { key: 'date', type: 'daterange', label: 'Date range', primary: true, get: (w) => w.createdAt },
  ], {
    sorts: [
      { key: 'new', label: 'Newest first', cmp: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) },
      { key: 'old', label: 'Oldest first', cmp: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) },
    ],
  });
  const page = usePaged(lf.rows);
  return (
    <>
      <div className="notice">
        Attributed by the position code stamped on each record when it was made — so everything done
        from this seat stays here, whoever was sitting in it at the time.
      </div>
      <ListFilterBar lf={lf} storageKey="admin-seat-work" noun="records" />
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>What</th><th>Detail</th><th>By whom</th><th>When</th></tr></thead>
          <tbody>
            {page.slice.map((w) => (
              <tr key={w.key}>
                <td><span className={`status ${w.badge}`}>{w.type}</span></td>
                <td>{w.title}<div className="small-muted">{w.sub}</div></td>
                <td className="cell-muted">{w.byWhom || '—'}</td>
                <td className="cell-muted">{fmt(String(w.createdAt).slice(0, 10))}</td>
              </tr>
            ))}
            {!lf.rows.length && (
              <tr><td colSpan="4">
                <ListEmpty
                  lf={lf}
                  noun="records"
                  title="Nothing has been recorded from this seat yet."
                  hint="Work is stamped with the position from the moment somebody holds it."
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="records" />
    </>
  );
}

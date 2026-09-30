import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import './Nominations.css';

// ---------------------------------------------------------------------------
// REWARDS & RECOGNITION → NOMINATION (hrms-24 §13).
//
//   Nominated → Pending Review → Approved / Rejected → Awarded
//
// Everything here is backed by /api/recognition-nominations
// (backend/src/routes/nominations.js), which decides who may nominate, review
// and award, and refuses any nominee outside the caller's scope. The buttons
// below only mirror the `rights` the server returns.
// ---------------------------------------------------------------------------

const STATUS_CLASS = {
  Nominated: 'new', 'Pending Review': 'pending', Approved: 'approved', Rejected: 'rejected', Awarded: 'active',
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtWhen = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const today = () => new Date().toISOString().slice(0, 10);

// ---- The nominee's performance, within the nominator's scope --------------
function ReferencePanel({ employeeId }) {
  const [ref, setRef] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!employeeId) { setRef(null); return; }
    setRef(null); setError('');
    api.get(`/recognition-nominations/reference/${employeeId}`)
      .then((r) => setRef(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Performance information could not be loaded.'));
  }, [employeeId]);
  if (!employeeId) return <div className="nom-ref nom-ref-empty">Pick an employee to see their performance reference.</div>;
  if (error) return <div className="nom-ref"><div className="error-text">{error}</div></div>;
  if (!ref) return <div className="nom-ref small-muted">Loading performance reference…</div>;
  const att = ref.attendance.byStatus || {};
  return (
    <div className="nom-ref">
      <div className="nom-ref-head">Performance reference <span className="small-muted">· last 90 days from {fmtDate(ref.windowFrom)}</span></div>
      <div className="nom-ref-grid">
        <div className="nom-kpi"><b>{ref.tasks.completed}</b><span>of {ref.tasks.total} tasks completed</span></div>
        <div className="nom-kpi"><b>{ref.tasks.approved}</b><span>tasks signed off</span></div>
        <div className="nom-kpi"><b>{ref.timesheet.hours}</b><span>timesheet hours ({ref.timesheet.entries} entries)</span></div>
        <div className="nom-kpi"><b>{ref.attendance.days}</b><span>attendance days on record</span></div>
        <div className="nom-kpi"><b>{ref.lms.completed}/{ref.lms.assigned}</b><span>LMS courses completed</span></div>
        <div className="nom-kpi"><b>{ref.recognitions.length}</b><span>previous recognitions</span></div>
      </div>
      {!!Object.keys(att).length && (
        <div className="nom-ref-line">Attendance: {Object.entries(att).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
      )}
      <div className="nom-ref-sec">Targets</div>
      {ref.targets.length ? ref.targets.map((t) => (
        <div className="nom-ref-row" key={t.id}>
          <span>{t.title}</span>
          <span className="small-muted">
            {t.amount != null ? `${t.achieved ?? 0} / ${t.amount}${t.unit ? ` ${t.unit}` : ''}` : (t.progressPct != null ? `${t.progressPct}%` : t.status)}
          </span>
        </div>
      )) : <div className="small-muted">No targets on record.</div>}
      {!!ref.lms.recent.length && (
        <>
          <div className="nom-ref-sec">LMS completions</div>
          {ref.lms.recent.map((c, i) => (
            <div className="nom-ref-row" key={i}><span>{c.course || 'Course'}</span><span className="small-muted">{fmtDate(c.completedAt)}{c.score != null ? ` · ${c.score}%` : ''}</span></div>
          ))}
        </>
      )}
      {!!ref.reviews.length && (
        <>
          <div className="nom-ref-sec">Performance reviews</div>
          {ref.reviews.map((r, i) => (
            <div className="nom-ref-row" key={i}><span>{r.period} · {r.band}</span><span className="small-muted">{r.score} · {r.recommendation}</span></div>
          ))}
        </>
      )}
      <div className="nom-ref-sec">Previous recognitions &amp; nominations</div>
      {ref.recognitions.length || ref.nominations.length ? (
        <>
          {ref.recognitions.map((r, i) => (
            <div className="nom-ref-row" key={`r${i}`}><span>{r.title}{r.points != null ? ` (+${r.points})` : ''}</span><span className="small-muted">{r.date || ''}</span></div>
          ))}
          {ref.nominations.map((n) => (
            <div className="nom-ref-row" key={n.id}><span>Nominated · {n.recognitionType}</span><span className="small-muted">{n.status} · {n.nominationDate}</span></div>
          ))}
        </>
      ) : <div className="small-muted">None yet.</div>}
    </div>
  );
}

// ---- Nominate ------------------------------------------------------------------
function NominateModal({ meta, onClose, onSaved }) {
  const [f, setF] = useState({
    nomineeId: '', recognitionType: '', otherType: '', reason: '', achievements: '',
    nominationDate: today(), comments: '', recommendedReward: '',
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nominee = meta.nominees.find((e) => e.id === f.nomineeId);
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setError(''); };

  async function submit(e) {
    e.preventDefault();
    if (!f.nomineeId) return setError('Pick the employee you are nominating.');
    if (!f.recognitionType) return setError('Pick a recognition type.');
    if (f.recognitionType === 'Other' && !f.otherType.trim()) return setError('Say what the recognition is for.');
    if (f.reason.trim().length < 10) return setError('Give the reason for the nomination (at least 10 characters).');
    setBusy(true);
    try {
      const res = await api.post('/recognition-nominations', f);
      let note = '';
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        try { await api.post(`/recognition-nominations/${res.data.id}/document`, fd); } catch (err) {
          note = ` The document was not attached: ${err.response?.data?.error || 'upload failed'}.`;
        }
      }
      onSaved(`${res.data.nomineeName} nominated for ${res.data.recognitionType} — sent for review.${note}`);
    } catch (err) {
      setError(err.response?.data?.error || 'The nomination could not be submitted.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Nominate for Recognition"
      size="xwide"
      onClose={onClose}
      foot={<>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" type="submit" form="nom-form" disabled={busy}>{busy ? 'Submitting…' : 'Submit Nomination'}</button>
      </>}
    >
      <div className="nom-compose">
        <form id="nom-form" className="nom-form" onSubmit={submit}>
          {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
          <label className="field"><span>Employee *</span>
            <Combo value={f.nomineeId} onChange={set('nomineeId')}>
              <option value="">Select employee</option>
              {meta.nominees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.employeeCode}{e.department ? ` · ${e.department}` : ''}</option>)}
            </Combo>
            <div className="small-muted">Only people in your scope are listed.</div>
          </label>
          <div className="nom-auto">
            <div><span>Employee ID</span><b>{nominee?.employeeCode || '—'}</b></div>
            <div><span>Name</span><b>{nominee?.name || '—'}</b></div>
            <div><span>Department</span><b>{nominee?.department || '—'}</b></div>
            <div><span>Designation</span><b>{nominee?.designation || '—'}</b></div>
          </div>
          <div className="nom-two">
            <label className="field"><span>Recognition Type *</span>
              <Combo value={f.recognitionType} onChange={set('recognitionType')}>
                <option value="">Select type</option>
                {meta.types.map((t) => <option key={t}>{t}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Date</span><input type="date" value={f.nominationDate} onChange={set('nominationDate')} /></label>
          </div>
          {f.recognitionType === 'Other' && (
            <label className="field"><span>Recognition for *</span><input value={f.otherType} onChange={set('otherType')} maxLength={80} /></label>
          )}
          <label className="field"><span>Reason *</span><textarea rows="3" value={f.reason} onChange={set('reason')} /></label>
          <label className="field"><span>Performance / achievement details</span><textarea rows="3" value={f.achievements} onChange={set('achievements')} /></label>
          <label className="field"><span>Supporting comments</span><textarea rows="2" value={f.comments} onChange={set('comments')} /></label>
          <div className="nom-two">
            <label className="field"><span>Recommended reward</span><input value={f.recommendedReward} onChange={set('recommendedReward')} placeholder="e.g. Certificate + gift voucher" /></label>
            <label className="field"><span>Supporting document</span>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files[0] || null)} />
              <div className="small-muted">PDF or image, up to 5 MB.</div>
            </label>
          </div>
        </form>
        <ReferencePanel employeeId={f.nomineeId} />
      </div>
    </Modal>
  );
}

// ---- One nomination: details, timeline, review and award -----------------------
function NominationModal({ id, rights, me, onClose, onChanged }) {
  const [n, setN] = useState(null);
  const [error, setError] = useState('');
  const [remarks, setRemarks] = useState('');
  const [award, setAward] = useState({ awardDate: today(), points: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [showRef, setShowRef] = useState(false);

  useEffect(() => {
    api.get(`/recognition-nominations/${id}`).then((r) => setN(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not open the nomination.'));
  }, [id]);

  async function act(path, body, done) {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/recognition-nominations/${id}/${path}`, body);
      setN(r.data); onChanged(done(r.data));
    } catch (e) {
      setError(e.response?.data?.error || 'That action could not be completed.');
    } finally { setBusy(false); }
  }

  async function download() {
    try {
      const res = await api.get(`/recognition-nominations/${id}/document`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = n.docName || 'document'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { setError('The document could not be downloaded.'); }
  }

  const own = n && n.nominatedById === me?.id;
  const superAdmin = (me?.hrmsRole || me?.role) === 'SUPER_ADMIN';
  const canDecide = n && rights.review && ['Nominated', 'Pending Review'].includes(n.status) && (!own || superAdmin);
  const canAward = n && rights.award && n.status === 'Approved';

  return (
    <Modal title={n ? `Nomination — ${n.nomineeName}` : 'Nomination'} size="wide" onClose={onClose}
      foot={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      {!n ? <div className="small-muted">Loading…</div> : (
        <div className="nom-detail">
          <div className="nom-detail-head">
            <span className={`status ${STATUS_CLASS[n.status] || ''}`}>{n.status}</span>
            <b>{n.recognitionType}</b>
          </div>
          <div className="nom-kv"><span>Nominee</span><b>{n.nomineeName} · {n.nomineeCode || '—'}</b></div>
          <div className="nom-kv"><span>Department · Designation</span><b>{n.nomineeDepartment || '—'} · {n.nomineeDesignation || '—'}</b></div>
          <div className="nom-kv"><span>Nominated by</span><b>{n.nominatedByName} · {fmtWhen(n.createdAt)}</b></div>
          <div className="nom-kv"><span>Nomination date</span><b>{fmtDate(n.nominationDate)}</b></div>
          <div className="nom-kv"><span>Reason</span><p>{n.reason}</p></div>
          {n.achievements && <div className="nom-kv"><span>Performance / achievements</span><p>{n.achievements}</p></div>}
          {n.comments && <div className="nom-kv"><span>Supporting comments</span><p>{n.comments}</p></div>}
          <div className="nom-kv"><span>Recommended reward</span><b>{n.recommendedReward || '—'}</b></div>
          <div className="nom-kv"><span>Supporting document</span>
            {n.hasDocument ? <button className="link-btn" onClick={download}>{n.docName}</button> : <b>—</b>}</div>
          {n.reviewerName && (
            <div className="nom-kv"><span>Reviewer · decision</span><b>{n.reviewerName} · {n.decision} · {fmtWhen(n.reviewedAt)}</b></div>
          )}
          {n.remarks && <div className="nom-kv"><span>Remarks</span><p>{n.remarks}</p></div>}
          {n.awardedAt && <div className="nom-kv"><span>Award date</span><b>{fmtDate(n.awardedAt)} · by {n.awardedByName}</b></div>}

          <div className="nom-sec">Timeline</div>
          <ol className="nom-timeline">
            {n.history.map((h, i) => (
              <li key={i}><b>{h.status}</b> <span className="small-muted">{fmtWhen(h.at)} · {h.by}</span>{h.note && <div className="small-muted">{h.note}</div>}</li>
            ))}
          </ol>

          {(rights.review || rights.nominate) && (
            <button className="btn btn-sm btn-ghost" onClick={() => setShowRef((v) => !v)}>{showRef ? 'Hide' : 'Show'} performance reference</button>
          )}
          {showRef && <ReferencePanel employeeId={n.nomineeId} />}

          {canDecide && (
            <div className="nom-action">
              <div className="nom-sec">Review</div>
              <label className="field"><span>Remarks {own ? '(you are deciding your own nomination — recorded as an override)' : ''}</span>
                <textarea rows="2" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Required when rejecting" />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('decision', { decision: 'Approved', remarks }, (x) => `Nomination for ${x.nomineeName} approved.`)}>Approve</button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act('decision', { decision: 'Rejected', remarks }, (x) => `Nomination for ${x.nomineeName} rejected.`)}>Reject</button>
              </div>
            </div>
          )}
          {canAward && (
            <div className="nom-action">
              <div className="nom-sec">Award</div>
              <div className="nom-two">
                <label className="field"><span>Award date</span><input type="date" value={award.awardDate} onChange={(e) => setAward({ ...award, awardDate: e.target.value })} /></label>
                <label className="field"><span>Leaderboard points</span><input type="number" min="0" value={award.points} onChange={(e) => setAward({ ...award, points: e.target.value })} placeholder="optional" /></label>
              </div>
              <label className="field"><span>Note</span><input value={award.remarks} onChange={(e) => setAward({ ...award, remarks: e.target.value })} /></label>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act('award', award, (x) => `${x.nomineeName} awarded ${x.recognitionType}.`)}>Mark Awarded</button>
              <div className="small-muted" style={{ marginTop: 6 }}>Awarding adds the recognition to the feed and leaderboard.</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function Nominations({ onAwarded }) {
  const { user } = useAuth();
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [rights, setRights] = useState({ nominate: false, review: false, award: false });
  const [nominating, setNominating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [notice, setNotice] = useState('');

  function load() {
    api.get('/recognition-nominations').then((r) => { setRows(r.data.rows); setRights(r.data.rights); }).catch(() => setRows([]));
  }
  useEffect(() => {
    api.get('/recognition-nominations/meta').then((r) => setMeta(r.data)).catch(() => setMeta(null));
    load();
  }, []);

  // THE FILTER STANDARD (components/ui/ListFilters.jsx): Search · Status ·
  // Type · Department · Nominated on | More: Nominated by · Reviewer. A login
  // that only sees its own awards gets no Department / people filters.
  const seesOthers = rights.nominate || rights.review;
  const nominatedOn = (r) => r.nominationDate || r.createdAt;
  const lf = useListFilters(rows, [
    { key: 'q', type: 'search', placeholder: 'Search nominee, ID, nominator, reason…', minWidth: 240,
      get: (r) => `${r.nomineeName} ${r.nomineeCode || ''} ${r.nominatedByName || ''} ${r.nomineeDepartment || ''} ${r.recognitionType || ''} ${r.reason || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (r) => r.status, options: meta?.statuses },
    { key: 'type', label: 'Type', primary: true, options: meta?.types, get: (r) => r.recognitionType,
      match: (r, v) => String(r.recognitionType || '').startsWith(v) },
    { key: 'department', label: 'Department', primary: true, show: seesOthers, get: (r) => r.nomineeDepartment },
    { key: 'date', type: 'daterange', label: 'Nominated on', primary: true, get: nominatedOn },
    { key: 'by', label: 'Nominated by', show: seesOthers, allLabel: 'Nominated by anyone', get: (r) => r.nominatedByName },
    { key: 'reviewer', label: 'Reviewer', show: seesOthers, allLabel: 'Any reviewer', get: (r) => r.reviewerName },
  ], {
    sorts: [
      { key: 'new', label: 'Newest first', cmp: (a, b) => String(nominatedOn(b)).localeCompare(String(nominatedOn(a))) },
      { key: 'old', label: 'Oldest first', cmp: (a, b) => String(nominatedOn(a)).localeCompare(String(nominatedOn(b))) },
      { key: 'name', label: 'Nominee A–Z', cmp: (a, b) => String(a.nomineeName || '').localeCompare(String(b.nomineeName || '')) },
    ],
  });
  const shown = lf.rows;
  const page = usePaged(shown);
  const pending = rows.filter((r) => r.status === 'Pending Review').length;

  // Nothing to show a login that cannot nominate or review and has no award.
  if (!rights.nominate && !rights.review && !rows.length) return null;

  return (
    <div className="panel nom" style={{ marginTop: 14 }}>
      <div className="panel-head">
        <h3>Nominations {pending ? <span className="status pending" style={{ marginLeft: 6 }}>{pending} pending review</span> : null}</h3>
        {rights.nominate && meta && <button className="btn btn-primary btn-sm" onClick={() => setNominating(true)}>+ Nominate</button>}
      </div>
      <div className="panel-pad">
        {notice && <div className="notice">{notice}</div>}
        <ListFilterBar lf={lf} storageKey="nominations" noun="nominations" />
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Nominee</th><th>Type</th><th>Nominated by</th><th>Date</th><th>Status</th><th>Reviewer</th><th /></tr></thead>
            <tbody>
              {page.slice.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.nomineeName}</b><div className="small-muted">{r.nomineeCode} · {r.nomineeDepartment || '—'}</div></td>
                  <td>{r.recognitionType}{r.recommendedReward ? <div className="small-muted">{r.recommendedReward}</div> : null}</td>
                  <td className="cell-muted">{r.nominatedByName}</td>
                  <td className="cell-muted">{fmtDate(r.nominationDate)}</td>
                  <td><span className={`status ${STATUS_CLASS[r.status] || ''}`}>{r.status}</span></td>
                  <td className="cell-muted">{r.reviewerName || '—'}</td>
                  <td><button className="btn btn-sm" onClick={() => setOpenId(r.id)}>{(rights.review && r.status === 'Pending Review') || (rights.award && r.status === 'Approved') ? 'Review' : 'View'}</button></td>
                </tr>
              ))}
              {!shown.length && (
                <tr><td colSpan="7" className="small-muted" style={{ padding: 14 }}><ListEmpty lf={lf} noun="nominations" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
        {shown.length > 0 && <Pager page={page} noun="nominations" />}
      </div>
      {nominating && meta && (
        <NominateModal meta={meta} onClose={() => setNominating(false)} onSaved={(msg) => { setNominating(false); setNotice(msg); load(); }} />
      )}
      {openId && (
        <NominationModal
          id={openId} rights={rights} me={user} onClose={() => setOpenId(null)}
          onChanged={(msg) => { setNotice(msg); load(); if (/awarded/.test(msg) && onAwarded) onAwarded(); }}
        />
      )}
    </div>
  );
}

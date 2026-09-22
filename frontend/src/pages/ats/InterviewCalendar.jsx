import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  INTERVIEW_STATUS_CODES, INTERVIEW_NEXT, INTERVIEW_TYPES,
  INTERVIEW_RECOMMENDATIONS, FEEDBACK_CRITERIA,
  interviewStatusLabel, interviewStatusClass, resultClass,
} from '../../atsVocab';
import { canActOnPipeline } from '../../permissions';
import { HiringTypeChip } from './intjoinShared.jsx';
import Combo from '../../components/Combo.jsx';

// The prototype's Interview Calendar (calendarView, line 9184): two tabs kept
// deliberately apart, because an AI interview score is never mixed into
// recruitment/client interview feedback.
//
// Recruitment chain: Scheduled -> Confirmed -> Started -> Completed ->
// Pending Feedback. Cancelled, No Show and Rescheduled are tracked separately —
// none of them rejects the candidate.

// Department, Client, Requirement, Candidate, Recruiter, TL, BDE, Interview
// Type, Status, Hiring Type and a date range — the full Interviews filter set.
const EMPTY_FILTERS = {
  q: '', status: '', type: '', date: '', client: '', recruiter: '', tl: '', bde: '',
  department: '', requirement: '', candidate: '', hiringType: '', from: '', to: '',
};

// Roles that may move an interview. Clients watch; the API enforces this too.

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function InterviewCalendar() {
  const { user } = useAuth();
  const [tab, setTab] = useState('recruitment');
  const [data, setData] = useState({ recruitment: [], ai: [], filterOptions: {} });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null); // { kind, row, ...fields }

  const canAct = canActOnPipeline(user);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

  function load() {
    api.get('/ats/calendar')
      .then((res) => setData(res.data))
      .catch(() => setError('Could not load the interview calendar.'));
  }
  useEffect(load, []);

  const opts = data.filterOptions || {};

  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return (data.recruitment || []).filter((r) => {
      if (filters.status && r.status !== filters.status) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (filters.client && r.requirement.client?.name !== filters.client) return false;
      if (filters.recruiter && r.requirement.recruiter?.name !== filters.recruiter) return false;
      if (filters.tl && r.requirement.tl !== filters.tl) return false;
      if (filters.bde && r.requirement.bde?.name !== filters.bde) return false;
      if (filters.department && r.requirement.department !== filters.department) return false;
      if (filters.requirement && r.requirement.title !== filters.requirement) return false;
      if (filters.candidate && r.candidate.name !== filters.candidate) return false;
      if (filters.hiringType && r.hiringType !== filters.hiringType) return false;
      if (filters.date && (!r.interviewAt || new Date(r.interviewAt).toISOString().slice(0, 10) !== filters.date)) return false;
      if (filters.from || filters.to) {
        if (!r.interviewAt) return false;
        const d = new Date(r.interviewAt).toISOString().slice(0, 10);
        if (filters.from && d < filters.from) return false;
        if (filters.to && d > filters.to) return false;
      }
      if (q && !`${r.candidate.name} ${r.requirement.title} ${r.interviewCode}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.recruitment, filters]);

  // Every action funnels through here so one failure path handles them all.
  async function act(fn, successMessage) {
    setError(''); setNotice('');
    try {
      await fn();
      setDialog(null);
      if (successMessage) setNotice(successMessage);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That action could not be completed.');
    }
  }

  const advance = (row, to) => act(
    () => api.patch(`/ats/interviews/${row.id}/advance`, { to }),
    `${row.candidate.name} — interview ${interviewStatusLabel(to === 'COMPLETED' ? 'PENDING_FEEDBACK' : to).toLowerCase()}.`,
  );

  const noShow = (row) => act(
    () => api.post(`/ats/interviews/${row.id}/no-show`),
    'Marked No Show — reschedule, or take a decision on the candidate profile.',
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Interview Calendar</h1>
          <div className="page-sub">
            AI Interviews and Recruitment / Client Interviews are tracked separately — an AI score is
            never mixed with client interview feedback.
          </div>
        </div>
        {/* The page's primary action. It only navigates, but it advertises a
            write this login may not make, so a view-only role (§3) is not
            shown it — the whole point of §3 is that the button is absent, not
            greyed out. `canAct` is the same matrix answer the API enforces. */}
        {canAct && <Link className="btn btn-primary" to="/candidates">Schedule Interview</Link>}
      </div>

      {/* §1 — NO WORKSPACE STRIP HERE. Interview Feedback, Offers, Joining
          and Internal Hiring are candidate workflow states, not peers of this
          module; listing them here is what made the ATS look like it had five
          more modules. They are reached from the candidate record and from the
          pipeline tabs that already carry them. */}

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="card section" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="tabbar">
        <button className={'tab-btn' + (tab === 'recruitment' ? ' active' : '')} onClick={() => setTab('recruitment')}>
          Recruitment / Client Interviews ({(data.recruitment || []).length})
        </button>
        <button className={'tab-btn' + (tab === 'ai' ? ' active' : '')} onClick={() => setTab('ai')}>
          AI Interviews ({(data.ai || []).length})
        </button>
      </div>

      <div className="tab-content">
        {tab === 'recruitment' ? (
          <>
            <div className="small-muted" style={{ marginBottom: 10 }}>
              Lifecycle: Client Shortlisted → Scheduled → Confirmed → Started → Completed → Pending Feedback
              → Selected / Rejected / Hold. Cancelled, No Show and Rescheduled are tracked separately.
            </div>

            <div className="filter-row" style={{ flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Search candidate, requirement or interview ID…"
                value={filters.q}
                onChange={(e) => setFilter({ q: e.target.value })}
              />
              <Combo value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
                <option value="">All statuses</option>
                {INTERVIEW_STATUS_CODES.map((s) => <option key={s} value={s}>{interviewStatusLabel(s)}</option>)}
              </Combo>
              <Combo value={filters.department} onChange={(e) => setFilter({ department: e.target.value })}>
                <option value="">All departments</option>
                {(opts.departments || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.requirement} onChange={(e) => setFilter({ requirement: e.target.value })}>
                <option value="">All requirements</option>
                {(opts.requirements || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.candidate} onChange={(e) => setFilter({ candidate: e.target.value })}>
                <option value="">All candidates</option>
                {(opts.candidates || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.hiringType} onChange={(e) => setFilter({ hiringType: e.target.value })}>
                <option value="">All hiring types</option>
                {(data.hiringTypes || []).map((d) => <option key={d}>{d}</option>)}
              </Combo>
              <Combo value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
                <option value="">All types</option>
                {INTERVIEW_TYPES.map((t) => <option key={t}>{t}</option>)}
              </Combo>
              <Combo value={filters.date} onChange={(e) => setFilter({ date: e.target.value })}>
                <option value="">All dates</option>
                {(opts.dates || []).map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
              </Combo>
              <Combo value={filters.client} onChange={(e) => setFilter({ client: e.target.value })}>
                <option value="">All clients</option>
                {(opts.clients || []).map((c) => <option key={c}>{c}</option>)}
              </Combo>
              <Combo value={filters.recruiter} onChange={(e) => setFilter({ recruiter: e.target.value })}>
                <option value="">All recruiters</option>
                {(opts.recruiters || []).map((r) => <option key={r}>{r}</option>)}
              </Combo>
              <Combo value={filters.tl} onChange={(e) => setFilter({ tl: e.target.value })}>
                <option value="">All TLs</option>
                {(opts.tls || []).map((t) => <option key={t}>{t}</option>)}
              </Combo>
              <Combo value={filters.bde} onChange={(e) => setFilter({ bde: e.target.value })}>
                <option value="">All BDEs</option>
                {(opts.bdes || []).map((b) => <option key={b}>{b}</option>)}
              </Combo>
              <label className="small-muted">From <input type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
              <label className="small-muted">To <input type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
              <button className="btn btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
              <span className="small-muted">{rows.length} interview(s)</span>
            </div>

            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Interview ID</th><th>Candidate</th><th>Requirement</th><th>Client</th>
                    <th>Hiring Type</th><th>Round</th><th>Type</th><th>Interviewer</th><th>Date</th><th>Time</th>
                    <th>Mode</th><th>Meeting / Location</th><th>Status</th><th>Score</th>
                    <th>Result</th><th>Created By</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.interviewCode}</b>
                        {r.rescheduleCount > 0 && <> <span className="status priority-medium">×{r.rescheduleCount}</span></>}
                      </td>
                      <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                      <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                      <td className="small-muted">{r.requirement.client?.name || '—'}</td>
                      <td><HiringTypeChip value={r.hiringType} /></td>
                      <td className="small-muted">{r.round}</td>
                      <td className="small-muted">{r.type}</td>
                      <td className="small-muted">{r.interviewer || '—'}</td>
                      <td className="small-muted">{fmtDate(r.interviewAt)}</td>
                      <td className="small-muted">{fmtTime(r.interviewAt)}</td>
                      <td className="small-muted">{r.mode || '—'}</td>
                      <td className="small-muted">{r.meeting || '—'}</td>
                      <td>
                        <span className={'status ' + interviewStatusClass(r.status)}>{r.statusLabel}</span>
                        {r.cancelReason && <div className="small-muted" style={{ fontSize: 11 }}>{r.cancelReason}</div>}
                      </td>
                      <td>{r.score != null ? <b>{r.score}%</b> : <span className="small-muted">—</span>}</td>
                      <td>{r.result === '—' ? <span className="small-muted">—</span> : <span className={'status ' + resultClass(r.result)}>{r.result}</span>}</td>
                      <td className="small-muted">{r.createdBy || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {!canAct ? <span className="small-muted">—</span> : <Actions row={r} advance={advance} noShow={noShow} setDialog={setDialog} />}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan="17" className="small-muted" style={{ padding: 16 }}>No interviews match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <AiTab rows={data.ai || []} canAct={canAct} act={act} />
        )}
      </div>

      {dialog?.kind === 'reschedule' && <RescheduleForm dialog={dialog} setDialog={setDialog} act={act} />}
      {dialog?.kind === 'cancel' && <CancelForm dialog={dialog} setDialog={setDialog} act={act} />}
      {dialog?.kind === 'feedback' && <FeedbackForm dialog={dialog} setDialog={setDialog} act={act} />}
      {dialog?.kind === 'history' && <HistoryPanel dialog={dialog} setDialog={setDialog} />}
    </div>
  );
}

// The prototype's ivActionsHtml(): what you can do depends entirely on where the
// interview currently is.
function Actions({ row, advance, noShow, setDialog }) {
  const st = row.status;
  const next = INTERVIEW_NEXT[st];
  const nextLabel = next === 'CONFIRMED' ? 'Confirm' : next === 'STARTED' ? 'Start' : 'Complete';

  if (['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(st)) {
    return (
      <>
        <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'reschedule', row })}>Reschedule</button>{' '}
        {st === 'RESCHEDULED' && <button className="btn btn-sm" onClick={() => advance(row, 'CONFIRMED')}>Confirm</button>}{' '}
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'history', row })}>History</button>
      </>
    );
  }
  if (['PENDING_FEEDBACK', 'COMPLETED', 'FEEDBACK_SUBMITTED'].includes(st)) {
    return (
      <>
        <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'feedback', row })}>
          {['COMPLETED', 'FEEDBACK_SUBMITTED'].includes(st) ? 'Edit Feedback' : 'Add Feedback'}
        </button>{' '}
        <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'history', row })}>History</button>
      </>
    );
  }
  return (
    <>
      {next && <><button className="btn btn-sm btn-primary" onClick={() => advance(row, next)}>{nextLabel}</button>{' '}</>}
      <button className="btn btn-sm" onClick={() => setDialog({ kind: 'reschedule', row })}>Reschedule</button>{' '}
      <button className="btn btn-sm" onClick={() => noShow(row)}>No Show</button>{' '}
      <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'cancel', row })}>Cancel</button>
    </>
  );
}

// Styles.css has no modal; the app's own pattern is an inline card, so these
// open below the table rather than importing the prototype's inline CSS.
function Panel({ title, subtitle, children, onClose }) {
  return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div><h3>{title}</h3>{subtitle && <div className="page-sub">{subtitle}</div>}</div>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
      {children}
    </div>
  );
}

function RescheduleForm({ dialog, setDialog, act }) {
  const { row } = dialog;
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Panel
      title={`Reschedule — ${row.candidate.name}`}
      subtitle={`Currently ${fmtDate(row.interviewAt)} ${fmtTime(row.interviewAt)} · ${row.statusLabel}`}
      onClose={() => setDialog(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post(`/ats/interviews/${row.id}/reschedule`, { interviewAt: when, reason }), `Rescheduled to ${fmtDate(when)}.`);
        }}
      >
        <div className="grid-2">
          <label className="field"><span>New date &amp; time *</span>
            <input required type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          <label className="field"><span>Reason *</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it moving?" /></label>
        </div>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          Every reschedule is kept in the interview&apos;s history — nothing is overwritten silently.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Reschedule</button>
      </form>
    </Panel>
  );
}

function CancelForm({ dialog, setDialog, act }) {
  const { row } = dialog;
  const [reason, setReason] = useState('');
  return (
    <Panel title={`Cancel interview — ${row.candidate.name}`} onClose={() => setDialog(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post(`/ats/interviews/${row.id}/cancel`, { reason }), 'Interview cancelled — the candidate stays where they were.');
        }}
      >
        <label className="field" style={{ marginBottom: 10 }}><span>Cancellation reason *</span>
          <textarea required rows="2" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          A cancelled interview is not a rejection — the candidate stays at their current stage.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Cancel interview</button>
      </form>
    </Panel>
  );
}

function FeedbackForm({ dialog, setDialog, act }) {
  const { row } = dialog;
  const fb = row.internalFeedback || {};
  const [form, setForm] = useState({
    technical: fb.technical ?? 3,
    communication: fb.communication ?? 3,
    experience: fb.experience ?? 3,
    roleFit: fb.roleFit ?? 3,
    score: row.score ?? '',
    feedback: fb.overall || row.feedback || '',
    result: INTERVIEW_RECOMMENDATIONS.includes(row.result) ? row.result : 'Selected',
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Panel
      title={`Interview feedback — ${row.candidate.name}`}
      subtitle={`${row.interviewCode} · Round ${row.round} · ${row.type}`}
      onClose={() => setDialog(null)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(
            () => api.post(`/ats/interviews/${row.id}/feedback`, form),
            'Feedback submitted — the interview is now Feedback Submitted. Take the decision on Interview Feedback.',
          );
        }}
      >
        <div className="grid-3">
          {FEEDBACK_CRITERIA.map((c) => (
            <label className="field" key={c.key}>
              <span>{c.label} (1–5)</span>
              <Combo value={form[c.key]} onChange={(e) => set({ [c.key]: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </Combo>
            </label>
          ))}
          <label className="field"><span>Score (0–100)</span>
            <input type="number" min="0" max="100" value={form.score} onChange={(e) => set({ score: e.target.value })} /></label>
          <label className="field"><span>Recommendation</span>
            <Combo value={form.result} onChange={(e) => set({ result: e.target.value })}>
              {INTERVIEW_RECOMMENDATIONS.map((r) => <option key={r}>{r}</option>)}
            </Combo></label>
        </div>
        <label className="field" style={{ marginBottom: 10 }}><span>Overall Feedback *</span>
          <textarea required rows="3" value={form.feedback} onChange={(e) => set({ feedback: e.target.value })} /></label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          This is the internal recruitment / client interview record — kept separate from the AI
          Interview score, and from the client&apos;s own feedback record.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Save feedback</button>
      </form>
    </Panel>
  );
}

function HistoryPanel({ dialog, setDialog }) {
  const { row } = dialog;
  return (
    <Panel title={`History — ${row.interviewCode}`} subtitle={row.candidate.name} onClose={() => setDialog(null)}>
      {(row.history || []).length === 0 && <div className="small-muted">Nothing recorded yet.</div>}
      {(row.history || []).map((h) => (
        <div className="timeline-item" key={h.id}>
          <b>{interviewStatusLabel(h.status)}</b>
          {h.by && <span className="small-muted"> · {h.by}</span>}
          {h.reason && <div className="small-muted">{h.reason}</div>}
          {h.fromSlot && h.toSlot && (
            <div className="small-muted">{fmtDate(h.fromSlot)} {fmtTime(h.fromSlot)} → {fmtDate(h.toSlot)} {fmtTime(h.toSlot)}</div>
          )}
          <div className="timeline-date">{new Date(h.createdAt).toLocaleString()}</div>
        </div>
      ))}
    </Panel>
  );
}

// An expired AI interview does NOT reject the candidate — it can be extended,
// resent, or handed to a recruiter for a manual screen.
function AiTab({ rows, canAct, act }) {
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        Lifecycle: Required → Scheduled → Started → Completed → AI Score + Feedback.
        An expired AI interview never rejects the candidate.
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>AI Interview ID</th><th>Candidate</th><th>Requirement</th><th>Status</th>
              <th>Deadline</th><th>AI Score</th><th>AI Feedback</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expired = r.status === 'Expired';
              return (
                <tr key={r.id}>
                  <td><b>{r.aiCode}</b></td>
                  <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                  <td className="small-muted">{r.requirement.title}</td>
                  <td>
                    <span className={'status ' + (r.status === 'Completed' ? 'priority-low' : expired ? 'priority-high' : '')}>
                      {r.status}
                    </span>
                  </td>
                  <td className="small-muted">{r.deadline ? fmtDate(r.deadline) : '—'}</td>
                  <td>{r.score != null ? <><b>{r.score}%</b> <span className="small-muted">(Simulated)</span></> : <span className="small-muted">—</span>}</td>
                  <td className="small-muted">
                    {r.feedback || (r.score != null ? 'AI-generated summary available on the candidate profile.' : '—')}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!canAct ? <span className="small-muted">—</span> : (
                      <>
                        {expired && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/extend`, {}), 'Deadline extended — the candidate stays active.')}>Extend Deadline</button>{' '}
                          </>
                        )}
                        <button className="btn btn-sm" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/resend`), 'AI interview invite resent (Email / WhatsApp / SMS).')}>Resend</button>{' '}
                        {expired && (
                          <button className="btn btn-sm" onClick={() => act(() => api.post(`/ats/ai-interviews/${r.id}/manual-review`), 'Manual review requested — a recruiter will screen this candidate directly.')}>Manual Review</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>No AI interviews on record.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card section" style={{ marginTop: 12 }}>
        An expired AI interview does <b>not</b> reject the candidate — the application stays in its
        current stage and can be extended, resent, or sent for manual review.
      </div>
    </>
  );
}

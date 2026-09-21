// Interviews & Joining -> Interview Feedback.
//
//   Completed -> Feedback Pending -> Feedback Submitted -> Decision
//
// Two feedback records sit side by side on every interview and are never
// merged: the INTERNAL panel's feedback and the CLIENT's own feedback. A
// client sees and writes only their own, on their own company's interviews.
// Neither is ever mixed with the AI interview score — that lives on the
// calendar's AI tab and nowhere else.

import { useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import {
  INTERVIEW_RECOMMENDATIONS, FEEDBACK_CRITERIA, interviewStatusLabel, interviewStatusClass, resultClass,
} from '../../atsVocab';
import {
  fmtDate, fmtTime, useWorkspace, Banner, Panel, HiringTypeChip, IntJoinFilters,
  EMPTY_INTJOIN_FILTERS, matchesShared, INTJOIN_TABS,
} from './intjoinShared.jsx';

export default function InterviewFeedback() {
  const { user } = useAuth();
  const { data, error, notice, act } = useWorkspace('/ats/feedback');
  const [filters, setFilters] = useState(EMPTY_INTJOIN_FILTERS);
  const [dialog, setDialog] = useState(null);

  const canInternal = can(user, 'ats', 'interviews', 'Interview Feedback', 'create');
  const canClient = can(user, 'ats', 'interviews', 'Client Feedback', 'create');
  const canDecide = can(user, 'ats', 'interviews', 'Interview Feedback', 'approve');

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const rows = useMemo(
    () => (data.rows || []).filter((r) => matchesShared(r, filters, r.interviewAt)),
    [data.rows, filters],
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Interview Feedback</h1>
          <div className="page-sub">
            Completed → Feedback Pending → Feedback Submitted → Decision. Internal feedback and client
            feedback are separate records on the same interview, and neither is ever mixed with an AI
            interview score.
          </div>
        </div>
      </div>

      <div className="tabbar">
        {INTJOIN_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => 'tab-btn' + (isActive ? ' active' : '')}>{t.label}</NavLink>
        ))}
      </div>

      <Banner error={error} notice={notice} />

      <IntJoinFilters
        filters={filters}
        setFilter={setFilter}
        opts={data.filterOptions || {}}
        onClear={() => setFilters(EMPTY_INTJOIN_FILTERS)}
        count={rows.length}
      />

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Interview ID</th><th>Candidate</th><th>Requirement</th><th>Client</th>
              <th>Hiring Type</th><th>Date</th><th>Status</th>
              <th>Internal Feedback</th><th>Client Feedback</th><th>Result</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.interviewCode}</b></td>
                <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                <td className="row-link"><Link to={`/requirements/${r.requirement.id}`}>{r.requirement.title}</Link></td>
                <td className="small-muted">{r.requirement.client?.name || '—'}</td>
                <td><HiringTypeChip value={r.hiringType} /></td>
                <td className="small-muted">{fmtDate(r.interviewAt)} {r.interviewAt ? fmtTime(r.interviewAt) : ''}</td>
                <td><span className={'status ' + interviewStatusClass(r.status)}>{interviewStatusLabel(r.status)}</span></td>
                <td><FeedbackCell fb={r.internalFeedback} /></td>
                <td><FeedbackCell fb={r.clientFeedback} /></td>
                <td>{r.result === '—' ? <span className="small-muted">—</span> : <span className={'status ' + resultClass(r.result)}>{r.result}</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {canInternal && (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'internal', row: r })}>
                        {r.internalFeedback ? 'Edit Internal' : 'Internal Feedback'}
                      </button>{' '}
                    </>
                  )}
                  {canClient && (
                    <>
                      <button className="btn btn-sm" onClick={() => setDialog({ kind: 'client', row: r })}>
                        {r.clientFeedback ? 'Edit Client Feedback' : 'Client Feedback'}
                      </button>{' '}
                    </>
                  )}
                  {canDecide && (
                    <button className="btn btn-sm" onClick={() => setDialog({ kind: 'decision', row: r })}>Decision</button>
                  )}
                  {!canInternal && !canClient && !canDecide && <span className="small-muted">—</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="11" className="small-muted" style={{ padding: 16 }}>No interviews are waiting on feedback.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'internal' && (
        <FeedbackForm
          kind="Internal"
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(body) => act(
            () => api.post(`/ats/interviews/${dialog.row.id}/feedback`, body),
            'Internal feedback submitted — the interview is now Feedback Submitted.',
          ).then((ok) => ok && setDialog(null))}
        />
      )}
      {dialog?.kind === 'client' && (
        <FeedbackForm
          kind="Client"
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(body) => act(
            () => api.post(`/ats/interviews/${dialog.row.id}/client-feedback`, body),
            'Client feedback recorded — kept separate from the internal panel feedback.',
          ).then((ok) => ok && setDialog(null))}
        />
      )}
      {dialog?.kind === 'decision' && (
        <DecisionForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(decision) => act(
            () => api.post(`/ats/interviews/${dialog.row.id}/decision`, { decision }),
            `Decision recorded — ${decision}.`,
          ).then((ok) => ok && setDialog(null))}
        />
      )}
    </div>
  );
}

function FeedbackCell({ fb }) {
  if (!fb) return <span className="small-muted">Not submitted</span>;
  const scores = FEEDBACK_CRITERIA
    .filter((c) => fb[c.key] != null)
    .map((c) => `${c.label} ${fb[c.key]}/5`)
    .join(' · ');
  return (
    <div>
      <span className={'status ' + resultClass(fb.recommendation)}>{fb.recommendation}</span>
      <div className="small-muted" style={{ fontSize: 11 }}>{scores || '—'}</div>
      <div className="small-muted" style={{ fontSize: 11 }}>{fb.submittedBy ? `by ${fb.submittedBy}` : ''}</div>
    </div>
  );
}

// Technical Skills · Communication · Experience · Role Fit · Overall Feedback
// · Recommendation. The same form serves both records; which record it writes
// is the `kind`, and the two never overwrite each other.
function FeedbackForm({ kind, row, onClose, onSubmit }) {
  const existing = kind === 'Internal' ? row.internalFeedback : row.clientFeedback;
  const [form, setForm] = useState({
    technical: existing?.technical ?? 3,
    communication: existing?.communication ?? 3,
    experience: existing?.experience ?? 3,
    roleFit: existing?.roleFit ?? 3,
    overall: existing?.overall ?? '',
    recommendation: existing?.recommendation ?? 'Selected',
    score: row.score ?? '',
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Panel
      title={`${kind === 'Internal' ? 'Internal interview feedback' : 'Client feedback'} — ${row.candidate.name}`}
      subtitle={`${row.interviewCode} · ${row.requirement.title} · ${row.requirement.client?.name || 'TeamLink (internal)'}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(kind === 'Internal' ? { ...form, feedback: form.overall, result: form.recommendation } : form);
        }}
      >
        <div className="grid-3">
          {FEEDBACK_CRITERIA.map((c) => (
            <label className="field" key={c.key}>
              <span>{c.label} (1–5)</span>
              <select value={form[c.key]} onChange={(e) => set({ [c.key]: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ))}
          <label className="field">
            <span>Recommendation</span>
            <select value={form.recommendation} onChange={(e) => set({ recommendation: e.target.value })}>
              {INTERVIEW_RECOMMENDATIONS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          {kind === 'Internal' && (
            <label className="field">
              <span>Interview score (0–100, optional)</span>
              <input type="number" min="0" max="100" value={form.score} onChange={(e) => set({ score: e.target.value })} />
            </label>
          )}
        </div>
        <label className="field" style={{ marginBottom: 10 }}>
          <span>Overall Feedback *</span>
          <textarea required rows="3" value={form.overall} onChange={(e) => set({ overall: e.target.value })} />
        </label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {kind === 'Internal'
            ? 'This is the internal panel’s record. It is never merged with the client’s feedback, and never with the AI interview score.'
            : 'This is the client’s own record. It sits beside the internal panel’s feedback and does not overwrite it.'}
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Submit {kind.toLowerCase()} feedback</button>
      </form>
    </Panel>
  );
}

// The decision is the pipeline move, and it is deliberately a separate act
// from recording feedback: the interview's STATUS stays Feedback Submitted.
function DecisionForm({ row, onClose, onSubmit }) {
  const [decision, setDecision] = useState(row.result !== '—' ? row.result : 'Selected');
  return (
    <Panel
      title={`Decision — ${row.candidate.name}`}
      subtitle={`Internal: ${row.internalFeedback?.recommendation || 'not submitted'} · Client: ${row.clientFeedback?.recommendation || 'not submitted'}`}
      onClose={onClose}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(decision); }}>
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Decision</span>
          <select value={decision} onChange={(e) => setDecision(e.target.value)}>
            {INTERVIEW_RECOMMENDATIONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          Selected moves the candidate on to Offers — as a {row.hiringType === 'TeamLink Internal Hire'
            ? 'TeamLink internal hire (internal offer → hired → HRMS employee, never invoiced)'
            : 'client placement (offer → joined client → invoice → receivable, never an HRMS employee)'}.
        </div>
        <button className="btn btn-primary btn-sm" type="submit">Record decision</button>
      </form>
    </Panel>
  );
}

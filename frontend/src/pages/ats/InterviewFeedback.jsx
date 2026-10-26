// Interviews & Joining -> Feedback (simplified 2026-10-03, change list §11 +
// the simplicity checklist).
//
//   Interview done → our feedback (short form) → the decision
//
// Two feedback records sit side by side on every interview and are never
// merged: OUR panel's feedback and the CLIENT's own. Neither is ever mixed
// with the AI interview score — that lives on the Interviews screen's AI tab.
// The Reject here is the SAME reject as everywhere else: the shared dialog
// (components/rejections/rejectionUi.jsx — whose decision, Not suitable /
// Do not use, a reason and a note, the client's own words), sent through the
// pipeline's own reject by POST /ats/interviews/:id/decision.

import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import Pager from '../../components/Pager.jsx';
import ListPageHeader from '../../components/ui/ListPageHeader.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import { Modal } from '../../components/proto.jsx';
import { stageLabel } from '../../atsVocab';
import ShortFeedbackForm, { ratingOf } from '../../components/interviews/ShortFeedbackForm.jsx';
import { RejectFields, EMPTY_REJECT, rejectReady } from '../../components/rejections/rejectionUi.jsx';
import { isLateFeedback } from '../../components/interviews/InterviewCalendarGrid.jsx';
import '../../components/interviews/Interviews.css';
// B4 (2026-10-06): the panel — each interviewer's own scorecard; the decision stays one.
import PanelView from '../../components/interviews/PanelView.jsx';
import {
  fmtDate, fmtTime, Banner, INTJOIN_TABS, IntJoinEmpty, EMPTY_INTJOIN_FILTERS, useIntJoinPaged, ShowOlder, PAGE_SIZES_IJ,
} from './intjoinShared.jsx';

const DECIDABLE = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'HOLD'];
// Where this interview is, in four plain words and the four colours.
function stepOf(r) {
  if (!DECIDABLE.includes(r.stage)) return { text: r.stage === 'REJECTED' ? 'Rejected' : `Decided — ${stageLabel(r.stage)}`, tone: r.stage === 'REJECTED' ? 'red' : 'green' };
  if (!r.internalFeedback) return isLateFeedback(r) ? { text: 'Feedback late', tone: 'red' } : { text: 'Needs feedback', tone: 'amber' };
  return { text: 'Needs decision', tone: 'blue' };
}
const STATUS = { label: 'Step', get: (r) => stepOf(r).text };

export default function InterviewFeedback() {
  const { user } = useAuth();
  // The server searches, counts and pages the list (utils/intJoinList.js).
  const ws = useIntJoinPaged('/ats/feedback', { status: STATUS });
  const {
    data, error, notice, act, load, list,
  } = ws;
  const [dialog, setDialog] = useState(null);
  const canInternal = can(user, 'ats', 'interviews', 'Interview Feedback', 'create');
  const canClient = can(user, 'ats', 'interviews', 'Client Feedback', 'create');
  const canDecide = can(user, 'ats', 'interviews', 'Interview Feedback', 'approve');
  const rows = data.rows || [];
  const page = ws.pager;
  const run = (fn, msg) => act(fn, msg);

  return (
    <div>
      <ListPageHeader
        title="Feedback"
        question="Interviews that are done: write what happened, then pick the next step."
        data={(
          <AtsDataTools
            module="feedback"
            kinds={['interview-feedback']}
            onImported={load}
            body={ws.exportBody}
          />
        )}
      />

      {/* The Interviews · Feedback · Offers · Joining tabs are drawn above the page by
          Shell.jsx (components/InterviewTabs.jsx) — tabs of Interview Calendar. */}

      <Banner error={error} notice={notice} />
      {list.toolbar}

      <div className="tbl-wrap" style={data.loading && rows.length ? { opacity: 0.55, transition: "opacity .15s" } : undefined} aria-busy={data.loading ? "true" : undefined}>
        <table>
          <thead>
            <tr>
              <th>Candidate</th><th>Requirement</th><th>Interview</th><th>Our feedback</th><th>Client said</th><th>Step</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const step = stepOf(r);
              const decidable = DECIDABLE.includes(r.stage);
              return (
                <tr key={r.id}>
                  <td className="row-link"><Link to={`/candidates/${r.candidate.id}`}>{r.candidate.name}</Link></td>
                  <td>
                    <div>{r.requirement.title}</div>
                    <div className="small-muted" style={{ fontSize: 12 }}>{r.hiringType === 'TeamLink Internal Hire' ? 'TeamLink (internal)' : r.requirement.client?.name || ''}</div>
                  </td>
                  <td className="small-muted">{fmtDate(r.interviewAt)} {r.interviewAt ? fmtTime(r.interviewAt) : ''}</td>
                  <td>
                    <FeedbackCell fb={r.internalFeedback} />
                    {(r.panel || []).length > 1 && (
                      <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 4 }} onClick={() => setDialog({ kind: 'panel', row: r })}>
                        {`Panel: ${r.panel.filter((p) => p.feedback).length} of ${r.panel.length} gave feedback`}
                      </button>
                    )}
                  </td>
                  <td><FeedbackCell fb={r.clientFeedback} /></td>
                  <td><StatusChip status={step.text} tone={step.tone} /></td>
                  <td>
                    <div className="ivx-actions">
                      {decidable && canInternal && !r.internalFeedback && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'internal', row: r })}>Add feedback</button>
                      )}
                      {decidable && canDecide && r.internalFeedback && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'decision', row: r })}>Decide</button>
                      )}
                      {decidable && canInternal && r.internalFeedback && (
                        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'internal', row: r })}>Edit feedback</button>
                      )}
                      {decidable && canClient && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog({ kind: 'client', row: r })}>{r.clientFeedback ? 'Edit client words' : 'Add client words'}</button>
                      )}
                      {/* founder 2026-10-26: once the client's feedback is in, the recruiter sends it to the candidate */}
                      {canInternal && r.clientFeedback && r.candidate && (
                        <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: 'tellCandidate', row: r })}>Send feedback to candidate</button>
                      )}
                      {(!decidable || (!canInternal && !canClient && !canDecide)) && !(canInternal && r.clientFeedback) && <span className="small-muted">—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan="7" style={{ padding: 0 }}>
                <IntJoinEmpty loading={data.loading} failed={data.failed} onRetry={load} filters={list.active ? { q: 'x' } : EMPTY_INTJOIN_FILTERS} onClear={list.clear} noun="interviews" title="No interviews are waiting on feedback." />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} noun="interviews" sizes={PAGE_SIZES_IJ} />
      <ShowOlder
        older={ws.older}
        setOlder={ws.setOlder}
        count={ws.olderCount}
        noun="interviews"
        openText="Showing interviews that wait for feedback or a decision, and those from the last 90 days."
      />

      {dialog?.kind === 'panel' && (
        <PanelModal
          row={dialog.row}
          user={user}
          canAct={canInternal}
          onClose={() => setDialog(null)}
          onChanged={(fresh) => { setDialog({ kind: 'panel', row: { ...dialog.row, panel: fresh.panel || dialog.row.panel } }); load(); }}
        />
      )}
      {dialog?.kind === 'internal' && (
        <ShortFeedbackForm
          row={dialog.row}
          existing={dialog.row.internalFeedback}
          onClose={() => setDialog(null)}
          onSubmit={(body) => run(() => api.post(`/ats/interviews/${dialog.row.id}/feedback`, body), `Feedback saved for ${dialog.row.candidate.name}.`)}
        />
      )}
      {dialog?.kind === 'client' && (
        <ShortFeedbackForm
          kind="Client"
          row={dialog.row}
          existing={dialog.row.clientFeedback}
          onClose={() => setDialog(null)}
          onSubmit={(body) => run(() => api.post(`/ats/interviews/${dialog.row.id}/client-feedback`, body), 'Saved what the client said.')}
        />
      )}
      {dialog?.kind === 'tellCandidate' && (
        <TellCandidateFeedback row={dialog.row} onClose={() => setDialog(null)} onSent={(msg) => { setDialog(null); run(() => Promise.resolve(), msg); }} />
      )}
      {dialog?.kind === 'decision' && (
        <DecisionForm
          row={dialog.row}
          onClose={() => setDialog(null)}
          onSubmit={(body, msg) => run(() => api.post(`/ats/interviews/${dialog.row.id}/decision`, body), msg).then((ok) => { if (ok) setDialog(null); return ok; })}
        />
      )}
    </div>
  );
}

function PanelModal({ row, user, canAct, onClose, onChanged }) {
  return (
    <Modal title={`Panel — ${row.candidate.name}`} onClose={onClose}>
      <PanelView row={row} user={user} canAct={canAct} onChanged={onChanged} />
    </Modal>
  );
}

function FeedbackCell({ fb }) {
  if (!fb) return <span className="small-muted">Not yet</span>;
  const r = ratingOf(fb);
  return (
    <div>
      <StatusChip status={fb.recommendation} tone={{ Selected: 'green', Rejected: 'red', Hold: 'amber' }[fb.recommendation]} />
      <div className="small-muted" style={{ fontSize: 11 }}>{[r ? `Rating ${r}/5` : null, fb.submittedBy ? `by ${fb.submittedBy}` : null].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

// The decision: Selected / Hold / Rejected. Reject = the shared reject form.
function DecisionForm({ row, onClose, onSubmit }) {
  const suggested = (row.internalFeedback && row.internalFeedback.recommendation) || '';
  const [decision, setDecision] = useState(suggested);
  const [note, setNote] = useState('');
  const [rej, setRej] = useState({ ...EMPTY_REJECT, rejectedBy: row.clientFeedback?.recommendation === 'Rejected' ? 'Client' : '' });
  const [busy, setBusy] = useState(false);
  const internal = row.hiringType === 'TeamLink Internal Hire';
  const ready = decision === 'Rejected' ? rejectReady(rej) : decision === 'Hold' ? !!note.trim() : decision === 'Selected';
  async function send() {
    setBusy(true);
    try {
      const first = String(row.candidate.name || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'The candidate';
      if (decision === 'Rejected') {
        await onSubmit({
          decision,
          rejectedBy: rej.rejectedBy,
          rejectKind: rej.rejectKind,
          reasonCategory: rej.reasonCategory,
          reasonDetail: rej.reasonDetail,
          ...(rej.rejectedBy === 'Client' && String(rej.clientSaid || '').trim() ? { comment: rej.clientSaid.trim() } : {}),
        }, `${first} is rejected for this requirement.`);
      } else {
        await onSubmit({ decision, reasonDetail: note.trim() || undefined, comment: note.trim() || undefined }, decision === 'Selected' ? `${first} is selected. Next: prepare the offer.` : `${first} is on hold.`);
      }
    } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Decide — ${row.candidate.name}`}
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={send}>{busy ? 'Saving…' : 'Save decision'}</button>}
    >
      <div className="ivx-fb">
        <div className="ivx-hint" style={{ marginTop: 0, marginBottom: 10 }}>
          {`Our feedback: ${row.internalFeedback?.recommendation || 'not yet'} · Client said: ${row.clientFeedback?.recommendation || 'not yet'}`}
          {(row.panel || []).length > 1 && <div>{`Panel: ${row.panel.map((p) => `${p.name} — ${p.feedback ? p.feedback.recommendation : 'no feedback yet'}`).join(' · ')}`}</div>}
        </div>
        <div className="ivx-sec">
          <b>Decision</b>
          <div className="ivx-outs" style={{ gridTemplateColumns: 'repeat(3,1fr)' }} role="radiogroup" aria-label="Decision">
            {[['Selected', 'green'], ['Hold', 'orange'], ['Rejected', 'red']].map(([v, tone]) => (
              <button key={v} type="button" role="radio" aria-checked={decision === v} className={`ivx-out ${tone}${decision === v ? ' is-on' : ''}`} onClick={() => setDecision(v)}>{v}</button>
            ))}
          </div>
        </div>
        {decision === 'Rejected' && <RejectFields value={rej} onChange={setRej} />}
        {decision === 'Hold' && (
          <div className="ivx-sec">
            <b>Why on hold?</b>
            <textarea rows="2" maxLength={1000} placeholder="e.g. Client will decide after the second round" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        {decision === 'Selected' && (
          <div className="ivx-hint">{internal ? 'Next: an offer from TeamLink, then joining and the employee record.' : 'Next: the offer, then joining and the invoice.'}</div>
        )}
      </div>
    </Modal>
  );
}

// SEND THE CLIENT'S FEEDBACK TO THE CANDIDATE (founder 2026-10-26). The recruiter reads the words first and may change them; it goes
// through the normal candidate message (Email), so it is in the candidate's Communications history like every other message.
function TellCandidateFeedback({ row, onClose, onSent }) {
  const fb = row.clientFeedback || {};
  const first = String((row.candidate && row.candidate.name) || '').trim().split(/s+/)[0] || 'there';
  const result = fb.recommendation === 'Selected' ? 'the client liked your interview and has selected you for the next step'
    : fb.recommendation === 'Rejected' ? 'the client has decided not to go ahead this time'
      : 'the client has put your profile on hold for now';
  const job = (row.requirement && row.requirement.title) || 'the role';
  const [text, setText] = useState(`Hi ${first},

Feedback from your interview for ${job}: ${result}.
${fb.overall ? `
What they said: ${fb.overall}
` : ''}
I will call you about the next step.

- TeamLink`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function send(e) {
    e.preventDefault();
    if (!text.trim()) { setErr('Write the message first.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/candidates/${row.candidate.id}/contact`, { method: 'Email', purpose: 'Interview feedback', subject: `Interview feedback: ${job}`, body: text, applicationId: row.id });
      const st = r.data && r.data.row && r.data.row.status;
      onSent(st === 'QUEUED' ? `Feedback sent to ${row.candidate.name} by email.` : `Feedback saved on ${row.candidate.name}'s record${r.data && r.data.row && r.data.row.statusDetail ? ` (${r.data.row.statusDetail})` : ''}.`);
    } catch (er) { setErr((er.response && er.response.data && er.response.data.error) || 'It could not be sent.'); setBusy(false); }
  }
  return (
    <Modal title="Send the client's feedback to the candidate" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="submit" form="ivx-tell" className="btn btn-primary" disabled={busy}>{busy ? 'Sending...' : 'Send by email'}</button></>}>
      <form id="ivx-tell" onSubmit={send}>
        {err && <div className="error-text">{err}</div>}
        <div className="small-muted" style={{ marginBottom: 8 }}>Client said: <b>{fb.recommendation || '—'}</b>{fb.submittedBy ? ` (by ${fb.submittedBy})` : ''}. Check the words before sending; the client's name is not in it.</div>
        <label className="field"><span>Message to {row.candidate.name}</span>
          <textarea rows="9" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

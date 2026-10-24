import { useState } from 'react';
import api from '../../api';
import { can } from '../../permissions';

// ---------------------------------------------------------------------------
// "ASK THE CLIENT MANAGER TO BOOK" (user, 2026-10-12: only the BDE books an interview).
//
//   <AskToBook applicationId stage interviewStatus requested onDone />   one plain button for a Recruiter / TL whose
//        candidate is "Sent to client" (or later) and has no interview booked. It tells the job's client manager
//        (BDE) with a bell (and a mail when company mail is connected): the candidate's name and the job only,
//        never a phone, an email or a salary. One press per candidate per day.
//   <InterviewRequested request />   the small blue line "Interview requested by <name>" until the BDE books it.
//   askable(user, row)               should this login be offered the button for this row?
//
// The server (routes/interviewRequest.js) decides; this file only draws the button.
// ---------------------------------------------------------------------------
export const ASK_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'];
const LIVE_SLOT = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];

// A login that cannot book but works the pipeline; a candidate that waits for a first (or next-round) interview.
export function askable(user, stage, interviewStatus, internal = false) {
  if (!user || internal) return false;
  if (can(user, 'ats', 'interviews', 'Schedule Interview', 'create')) return false; // they can book it themselves
  if (!can(user, 'ats', 'candidates', 'Applications', 'view')) return false;
  if (!ASK_STAGES.includes(stage)) return false;
  if (LIVE_SLOT.includes(interviewStatus)) return false;
  if (stage === 'INTERVIEW_SCHEDULED' && !['CANCELLED', 'NO_SHOW', 'FEEDBACK_SUBMITTED'].includes(interviewStatus)) return false;
  if (stage === 'INTERVIEW_COMPLETED' && interviewStatus !== 'FEEDBACK_SUBMITTED') return false;
  return true;
}

export function InterviewRequested({ request, style }) {
  if (!request || !request.line) return null;
  return <span className="status pending ask-chip" style={style} title="The client manager (BDE) has been asked to book the interview.">{request.line}</span>;
}

export default function AskToBook({
  applicationId, requested = null, onDone = null, label = 'Ask the client manager to book', compact = true, className = '',
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [asked, setAsked] = useState(requested);
  async function ask() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.post(`/ats/interviews/${applicationId}/ask-book`);
      setMsg(r.data.message || 'Asked.');
      setAsked({ line: `Interview requested${r.data.by ? ` by ${r.data.by}` : ''}` });
      if (onDone) onDone(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not ask just now. Please try again.');
    } finally { setBusy(false); }
  }
  return (
    <span className={`ask-book${className ? ` ${className}` : ''}`}>
      <button type="button" className={`btn${compact ? ' btn-sm' : ''}`} disabled={busy} onClick={ask}>
        {busy ? 'Asking…' : label}
      </button>
      {asked && <InterviewRequested request={asked} style={{ marginLeft: 6 }} />}
      {msg && <span className="small-muted" role="status" style={{ marginLeft: 6 }}>{msg}</span>}
      {err && <span className="error-text" style={{ marginLeft: 6 }}>{err}</span>}
    </span>
  );
}

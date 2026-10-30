import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// ---------------------------------------------------------------------------
// TALK HISTORY (founder 2026-10-29: "call ayyaka, timeline lo talk history aney oka button vundali. adhi click cheyyaganey,
// em matladaro mottham kanipinchali"). The whole conversation of one AI call, line by line - the assistant on the left,
// the candidate on the right - from GET /ai-calling/calls/:id (the transcript is read only by those who may place calls).
// A candidate line shows the EXACT words heard, and apart from them, in grey, how the AI read them (2026-10-29): the
// reading is never shown as if the person said it. Answers that were not heard clearly, or no reply, are marked.
// ---------------------------------------------------------------------------

const talked = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const UNDERSTOOD = {
  yes: 'Yes', no: 'No', mixed: 'Yes and no — asked again', maybe: 'Not sure / maybe', repeat: 'Asked to repeat', cant_hear: "Couldn't hear the AI",
  later: 'Call later', reschedule: 'Change the time', salary_q: 'Asked about salary', info_q: 'Asked a question', stop: 'Do not call', human: 'Wants a recruiter',
  ai_q: 'Asked if this is AI', other_cand: 'Asked about others', unclear: 'Not understood', not_clear: 'Not heard clearly (asked again)', silence: 'No reply',
  language: 'Asked for a language', question: 'Asked a question', 'explain again': 'Asked to explain the job again',
};
const ANSWERED = { 'from the ATS': 'answered from the ATS', 'recruiter answer': "answered with the recruiter's answer", 'to confirm': 'not in the ATS - kept for the recruiter (AI Calling > Questions)' };
const clock = (at) => {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
};

export function TalkHistoryButton({ call }) {
  const [open, setOpen] = useState(false);
  if (!call || !call.hasTranscript) return null;
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>💬 Talk history</button>
      {open && <TalkHistoryWindow id={call.id} onClose={() => setOpen(false)} />}
    </>
  );
}

export function TalkHistoryWindow({ id, onClose }) {
  const [call, setCall] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/ai-calling/calls/${id}`)
      .then((r) => setCall(r.data.call || r.data))
      .catch((e) => setErr(e.response?.data?.error || 'The conversation could not be opened.'));
  }, [id]);
  const lines = (call && call.transcript) || [];
  return (
    <Modal
      title="Talk history"
      note={call ? [call.candidateName, call.language, call.durationSec != null ? `talked ${talked(call.durationSec)}` : null, call.outcome].filter(Boolean).join(' · ') : null}
      onClose={onClose}
      foot={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      {err && <div className="error-text">{err}</div>}
      {!err && !call && <div className="small-muted">Loading…</div>}
      {call && !lines.length && <div className="small-muted">Nothing was kept for this call.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '60vh', overflow: 'auto' }}>
        {lines.map((t, i) => {
          const ai = t.who === 'assistant';
          const none = !ai && (t.heard === 'none' || (!t.text && !t.heard));
          const unclear = !ai && t.heard === 'unclear';
          const reading = !ai && !none && UNDERSTOOD[t.understood];
          const at = clock(t.at);
          return (
            <div key={i} style={{ alignSelf: ai ? 'flex-start' : 'flex-end', maxWidth: '82%' }}>
              <div className="small-muted" style={{ fontSize: 11, textAlign: ai ? 'left' : 'right' }}>
                {ai ? 'AI assistant' : 'Candidate'}
                {!ai && t.lang ? ` · ${t.lang}` : ''}
                {at ? ` · ${at}` : ''}
              </div>
              <div style={{
                background: ai ? 'var(--paper, #f4f6fa)' : '#e8f0fe', border: '1px solid var(--line, #e2e6ee)', borderRadius: 10,
                padding: '6px 10px', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', opacity: none || unclear ? 0.75 : 1,
              }}
              >
                {!ai && !none && <div className="small-muted" style={{ fontSize: 11 }}>Heard (exact words)</div>}
                {none ? <span className="small-muted">No reply heard</span> : (t.text || <span className="small-muted">(no words came through)</span>)}
                {unclear && <div><span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: 'var(--line, #e2e6ee)' }}>Not heard clearly — asked again</span></div>}
              </div>
              {reading && !unclear && <div className="small-muted" style={{ fontSize: 11, textAlign: 'right', marginTop: 2 }}>{`AI understood: ${reading}${ANSWERED[t.answered] ? ` · ${ANSWERED[t.answered]}` : ''}`}</div>}
            </div>
          );
        })}
      </div>
      {call && call.summary && <div className="small-muted" style={{ marginTop: 10 }}>{call.summary}</div>}
    </Modal>
  );
}

export default TalkHistoryButton;

import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// ---------------------------------------------------------------------------
// TALK HISTORY (founder 2026-10-29: "call ayyaka, timeline lo talk history aney oka button vundali. adhi click cheyyaganey,
// em matladaro mottham kanipinchali"). The whole conversation of one AI call, line by line - the assistant on the left,
// the candidate on the right - from GET /ai-calling/calls/:id (the transcript is read only by those who may place calls).
// ---------------------------------------------------------------------------

const talked = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);

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
          return (
            <div key={i} style={{ alignSelf: ai ? 'flex-start' : 'flex-end', maxWidth: '82%' }}>
              <div className="small-muted" style={{ fontSize: 11, textAlign: ai ? 'left' : 'right' }}>{ai ? 'AI assistant' : 'Candidate'}</div>
              <div style={{
                background: ai ? 'var(--paper, #f4f6fa)' : '#e8f0fe', border: '1px solid var(--line, #e2e6ee)', borderRadius: 10,
                padding: '6px 10px', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              }}
              >
                {t.text || <span className="small-muted">(nothing heard)</span>}
              </div>
            </div>
          );
        })}
      </div>
      {call && call.summary && <div className="small-muted" style={{ marginTop: 10 }}>{call.summary}</div>}
    </Modal>
  );
}

export default TalkHistoryButton;

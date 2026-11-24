import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { useBrowserCall } from './CallProvider.jsx';

export const mmss = (n) => (n == null ? '—' : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`);
const PHONE_STATUS = { requested: 'Call initiated', initiated: 'Sent to the phone', calling: 'On the phone', completed: 'Call completed', missed: 'Not answered / busy', busy: 'Busy', failed: 'Call failed', cancelled: 'Cancelled' };
export const statusWord = (s, dir) => (dir === 'inbound' && s === 'missed' ? 'Missed' : null) || (dir === 'phone' ? PHONE_STATUS[s] : null) || ({ completed: 'Connected', connected: 'Connected', failed: 'Failed', busy: 'Busy', missed: 'No answer', cancelled: 'Cancelled', calling: 'Calling', ringing: 'Ringing', initiated: 'Starting', requested: 'Asked ViciDial to dial' }[s] || s);
const at = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const REC_WORD = { pending: 'Recording is being prepared…', processing: 'Recording is being prepared…', missing: 'No recording came from the phone system', failed: 'The recording could not be prepared', off: 'Not recorded (recording was off)', deleted: 'Recording deleted (kept for a limited time)' };

// Play: the recording is fetched with this login (an authenticated route) and played here; nothing is cached.
export function PlayButton({ call }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const urlRef = useRef('');
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  if (!call.mayListen) return null;
  if (!call.hasRecording) return call.answerAt && REC_WORD[call.recordingStatus] ? <span className="small-muted">{REC_WORD[call.recordingStatus]}</span> : null;
  if (url) return <audio controls autoPlay src={url} style={{ height: 30, maxWidth: 240 }} data-testid="call-audio" />;
  const play = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.get(`/browser-calling/calls/${call.id}/recording`, { responseType: 'blob' });
      const u = URL.createObjectURL(r.data); urlRef.current = u; setUrl(u);
    } catch (e) { setErr('Could not play it.'); } finally { setBusy(false); }
  };
  return (
    <span>
      <button type="button" className="btn btn-sm" onClick={play} disabled={busy}>{busy ? 'Loading…' : '▶ Play'}</button>
      {call.recordingSec ? <span className="small-muted" style={{ marginLeft: 4 }}>{mmss(call.recordingSec)}</span> : null}
      {err && <span className="small-muted" style={{ marginLeft: 4 }}>{err}</span>}
    </span>
  );
}

// The summary, and "Show full conversation" (the transcript, read through the same access check).
export function CallSummary({ call }) {
  const [open, setOpen] = useState(false);
  const [conv, setConv] = useState(null);
  const [err, setErr] = useState('');
  if (!call.mayListen) return null;
  const show = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (conv) return;
    try { setConv((await api.get(`/browser-calling/calls/${call.id}/transcript`)).data); } catch (e) { setErr(errOf(e, 'Could not load the conversation.')); }
  };
  return (
    <div style={{ fontSize: 12.5 }} data-testid="call-summary">
      {call.summaryText ? <div>{call.summaryText}</div> : (call.answerAt && call.transcriptNote ? <div className="small-muted">{call.transcriptNote}</div> : null)}
      {call.hasTranscript && <button type="button" className="btn btn-sm" style={{ marginTop: 4 }} onClick={show}>{open ? 'Hide conversation' : 'Show full conversation'}</button>}
      {open && (
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, padding: 8, border: '1px solid var(--line, #e4e7ec)', borderRadius: 6, maxHeight: 260, overflow: 'auto' }}>
          {err || (conv ? (conv.transcript || 'No transcript.') : 'Loading…')}
          {conv && conv.transcriptSource && <div className="small-muted" style={{ marginTop: 6 }}>Transcript: {conv.transcriptSource}{conv.summarySource ? ` · Summary: ${conv.summarySource}` : ''}</div>}
        </div>
      )}
    </div>
  );
}

// Real calls made from the browser (or on a phone line) to this candidate (rows written from Asterisk events). Hidden when the login may not use browser calling.
export default function CallHistory({ candidateId }) {
  const { available, state } = useBrowserCall();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!available || !candidateId) return;
    api.get(`/browser-calling/candidates/${candidateId}/calls`).then((r) => { setRows(r.data.rows || []); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the call history.')));
  }, [available, candidateId, state.phase === 'ended' || state.phase === 'failed', state.phase === 'vici' ? state.callId : null, !!state.saved]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!available) return null;
  return (
    <div className="card section" data-testid="call-history">
      <div className="section-label">Calls{rows ? ` (${rows.length})` : ''}</div>
      {err && <div className="notice red">{err}</div>}
      {rows && rows.length === 0 && <div className="small-muted">No calls yet.</div>}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>When</th><th>Called by</th><th>Line</th><th>Ring</th><th>Talk</th><th>Result</th><th>Recording</th><th>What was said</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{at(r.startAt)}</td><td>{r.userName || '—'}{r.direction === 'inbound' ? <div className="small-muted" data-testid="call-incoming">Incoming, to their SIM</div> : null}</td><td data-testid={r.vicidial ? 'vici-line' : undefined}>{r.vicidial ? `ViciDial · requested by ${r.userName || '—'}` : (r.lineName || 'Office Synway (SIM)')}</td>
                  <td>{mmss(r.ringSec)}</td><td data-testid="talk-time">{mmss(r.talkSec)}</td>
                  <td>{r.vicidial && r.outcomeNote ? r.outcomeNote : statusWord(r.status, r.direction)}{!r.vicidial && r.hangupReason && r.status !== 'completed' ? <div className="small-muted">{r.hangupReason}</div> : null}{r.phone && (r.remarks || r.nextAction || r.followUpAt) ? <div className="small-muted" data-testid="phone-call-notes">{[r.outcome, r.remarks, r.nextAction && `Next: ${r.nextAction}`, r.followUpAt && `Follow-up ${r.followUpAt}`].filter(Boolean).join(' · ')}</div> : null}</td>
                  <td>{r.vicidial ? <span className="small-muted">Recorded in ViciDial</span> : <PlayButton call={r} />}</td>
                  <td style={{ minWidth: 220 }}><CallSummary call={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

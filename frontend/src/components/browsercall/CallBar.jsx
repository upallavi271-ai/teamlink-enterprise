import { useBrowserCall } from './CallProvider.jsx';

const WORD = { starting: 'Starting…', calling: 'Calling…', ringing: 'Ringing…', connected: 'Connected', failed: 'Failed', ended: 'Ended' };
const mmss = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// The one floating call panel: status, timer, Mute / Hold / Hang up. Shown only while a call is on or just finished.
export default function CallBar() {
  const { state, seconds, hangup, toggleMute, toggleHold, dismiss } = useBrowserCall();
  if (!state || state.phase === 'idle') return null;
  const live = ['starting', 'calling', 'ringing', 'connected'].includes(state.phase);
  const rec = state.record;
  const why = state.phase === 'failed' ? (state.error || (rec && rec.hangupReason)) : (state.phase === 'ended' && rec && rec.talkSec != null ? `Talk time ${mmss(rec.talkSec)}` : '');
  return (
    <div role="status" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 9999, width: 280, background: 'var(--card, #fff)', color: 'var(--text, #111)', border: '1px solid var(--border, #d0d5dd)', borderRadius: 10, boxShadow: '0 6px 24px rgba(0,0,0,.18)', padding: 12 }}>
      <div style={{ fontWeight: 600 }}>{state.name || 'Candidate'}</div>
      <div className="small-muted">{state.number ? `${state.number.slice(0, 2)}XXXXXX${state.number.slice(-2)}` : ''}</div>
      <div style={{ margin: '6px 0', fontSize: 15 }}>
        <b style={{ color: state.phase === 'failed' ? '#b42318' : state.phase === 'connected' ? '#067647' : undefined }}>{WORD[state.phase]}</b>
        {state.phase === 'connected' && <span style={{ marginLeft: 8 }}>{mmss(seconds)}{state.held ? ' · On hold' : ''}{state.muted ? ' · Muted' : ''}</span>}
      </div>
      {why && <div className="small-muted" style={{ marginBottom: 6 }}>{why}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {state.phase === 'connected' && (
          <>
            <button type="button" className="btn btn-sm" onClick={toggleMute}>{state.muted ? 'Unmute' : 'Mute'}</button>
            <button type="button" className="btn btn-sm" onClick={toggleHold}>{state.held ? 'Resume' : 'Hold'}</button>
          </>
        )}
        {live && <button type="button" className="btn btn-sm" style={{ background: '#b42318', color: '#fff' }} onClick={hangup}>Hang up</button>}
        {!live && <button type="button" className="btn btn-sm" onClick={dismiss}>Close</button>}
      </div>
    </div>
  );
}

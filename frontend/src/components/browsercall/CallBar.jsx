import { useBrowserCall } from './CallProvider.jsx';

const WORD = { starting: 'Starting…', calling: 'Calling…', ringing: 'Ringing…', connected: 'Connected', failed: 'Failed', ended: 'Ended' };
const mmss = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// "Call using": the phone lines this login may call on (the office Synway first). The choice is remembered on this computer.
export function LineSelect({ disabled = false }) {
  const { lines, line, chooseLine } = useBrowserCall();
  if (!lines || lines.length === 0) return null;
  return (
    <label className="field" style={{ margin: '4px 0 8px', display: 'block' }}>
      <span>Call using</span>
      <select aria-label="Call using" value={line ? line.id : ''} disabled={disabled || lines.length < 2} onChange={(e) => chooseLine(e.target.value)} style={{ width: '100%' }}>
        {lines.map((l) => <option key={l.id} value={l.id}>{l.name}{l.builtIn ? '' : ` · ${l.typeLabel}`}</option>)}
      </select>
    </label>
  );
}

// The one floating call panel: status, timer, Mute / Hold / Hang up. Shown only while a call is on or just finished, or while the line is being picked.
export default function CallBar() {
  const { state, seconds, hangup, toggleMute, toggleHold, dismiss, call } = useBrowserCall();
  if (!state || state.phase === 'idle') return null;
  const box = { position: 'fixed', right: 16, bottom: 16, zIndex: 9999, width: 280, maxWidth: 'calc(100vw - 32px)', background: 'var(--card, #fff)', color: 'var(--text, #111)', border: '1px solid var(--border, #d0d5dd)', borderRadius: 10, boxShadow: '0 6px 24px rgba(0,0,0,.18)', padding: 12 };
  if (state.phase === 'choose') {
    return (
      <div role="dialog" aria-label="Pick the line" style={box} data-testid="call-bar">
        <div style={{ fontWeight: 600 }}>{state.name || 'Candidate'}</div>
        <LineSelect />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => call({ candidateId: state.candidateId, applicationId: state.applicationId, name: state.name, outreachTaskId: state.outreachTaskId })}>{'☎'} Call</button>
          <button type="button" className="btn btn-sm" onClick={dismiss}>Cancel</button>
        </div>
      </div>
    );
  }
  const live = ['starting', 'calling', 'ringing', 'connected'].includes(state.phase);
  const rec = state.record;
  const why = state.phase === 'failed' ? (state.error || (rec && rec.hangupReason)) : (state.phase === 'ended' && rec && rec.talkSec != null ? `Talk time ${mmss(rec.talkSec)}` : '');
  return (
    <div role="status" style={box} data-testid="call-bar">
      <div style={{ fontWeight: 600 }}>{state.name || 'Candidate'}</div>
      <div className="small-muted">{state.number ? `${state.number.slice(0, 2)}XXXXXX${state.number.slice(-2)}` : ''}{state.lineName ? ` · on ${state.lineName}` : ''}</div>
      <div style={{ margin: '6px 0', fontSize: 15 }}>
        <b style={{ color: state.phase === 'failed' ? '#b42318' : state.phase === 'connected' ? '#067647' : undefined }}>{WORD[state.phase]}</b>
        {state.phase === 'connected' && <span style={{ marginLeft: 8 }}>{mmss(seconds)}{state.held ? ' · On hold' : ''}{state.muted ? ' · Muted' : ''}</span>}
      </div>
      {why && <div className="small-muted" style={{ marginBottom: 6 }}>{why}</div>}
      {!live && <LineSelect />}
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

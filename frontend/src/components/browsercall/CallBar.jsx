import { useState } from 'react';
import { useBrowserCall } from './CallProvider.jsx';
import { openFromClick, popupHost } from './vicidialPopup.js';

const WORD = { starting: 'Starting…', calling: 'Calling…', ringing: 'Ringing…', connected: 'Connected', failed: 'Failed', ended: 'Ended', missed: 'Missed' };

// ONE SIM PER RECRUITER: the person's own SIM, read-only. "Your calling number" only while the Admin's port routing is on (otherwise the
// office gateway may still pick another SIM for the call, so it says so).
export function MyCallingNumber({ lineName }) {
  const { mySim, line } = useBrowserCall();
  if (!mySim) return null;
  const onSynway = lineName ? /^Office Synway/.test(lineName) : !!(line && line.builtIn);
  if (!onSynway) return null;
  return (
    <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }} data-testid="my-sim-number">
      {mySim.routing ? <>Your calling number: <b>{mySim.number}</b></> : <>Your SIM: <b>{mySim.number}</b> · calls back to it ring here (outgoing calls may still show another office SIM until an Admin switches on port routing)</>}
    </div>
  );
}

// A candidate calling the person's SIM back: who it is (looked up by the server, scope-checked; the number only masked), Answer / Decline.
function IncomingPanel({ state, box }) {
  const { answer, decline } = useBrowserCall();
  return (
    <div role="alertdialog" aria-label="Incoming call" style={{ ...box, borderColor: '#067647', boxShadow: '0 0 0 3px rgba(6,118,71,.18), 0 6px 24px rgba(0,0,0,.18)' }} data-testid="incoming-call">
      <div className="small-muted" style={{ fontSize: 12 }}>Incoming call · on {state.lineName || 'your SIM'}</div>
      <div style={{ fontWeight: 600, fontSize: 15, marginTop: 2 }} data-testid="incoming-name">{state.name || 'Incoming call'}</div>
      {state.requirement && <div className="small-muted" data-testid="incoming-requirement">{state.requirement}</div>}
      <div className="small-muted" data-testid="incoming-number">{state.maskedNumber || ''}</div>
      {state.note && <div className="small-muted" style={{ color: '#b42318' }}>{state.note}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button type="button" className="btn btn-sm" style={{ background: '#067647', color: '#fff' }} onClick={answer}>Answer</button>
        <button type="button" className="btn btn-sm" style={{ background: '#b42318', color: '#fff' }} onClick={decline}>Decline</button>
      </div>
    </div>
  );
}
const mmss = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// "Call using": the phone lines this login may call on (the office Synway first). The choice is remembered on this computer.
export function LineSelect({ disabled = false }) {
  const { lines, line, chooseLine } = useBrowserCall();
  if (!lines || lines.length === 0) return null;
  // a line that is listed but not usable yet (ViciDial before an Admin switches it on, or without your agent ID) is shown greyed with the reason
  const notReady = lines.filter((l) => l.ready === false && l.reason);
  return (
    <label className="field" style={{ margin: '4px 0 8px', display: 'block' }}>
      <span>Call using</span>
      <select aria-label="Call using" value={line ? line.id : ''} disabled={disabled || lines.filter((l) => l.ready !== false).length < 2} onChange={(e) => chooseLine(e.target.value)} style={{ width: '100%' }}>
        {lines.map((l) => <option key={l.id} value={l.id} disabled={l.ready === false}>{l.vicidial ? `ViciDial${l.ready === false ? ' (not connected yet)' : ' · on your ViciDial agent screen'}` : `${l.name}${l.builtIn ? '' : ` · ${l.typeLabel}`}`}</option>)}
      </select>
      {notReady.map((l) => <span key={l.id} className="small-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }} data-testid={`line-reason-${l.id}`}>{l.name}: {l.reason}</span>)}
      {line && line.vicidial && <span className="small-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }}>ViciDial dials on your ViciDial agent screen: be logged in there. Recorded in ViciDial.</span>}
    </label>
  );
}

const OUTCOMES = ['Connected', 'No answer', 'Busy', 'Wrong number'];
// After a ViciDial dial: the popup went to ViciDial (or the pop-up was blocked: one click on the link), then how the call went.
function ViciPanel({ state, box, dismiss }) {
  const { viciOutcome } = useBrowserCall();
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [clicked, setClicked] = useState(false);
  const save = async () => { setBusy(true); await viciOutcome({ outcome: pick, note }); setBusy(false); };
  return (
    <div role="status" style={box} data-testid="call-bar">
      <div style={{ fontWeight: 600 }}>{state.name || 'Candidate'}</div>
      <div className="small-muted">{state.number ? `${state.number.slice(0, 2)}XXXXXX${state.number.slice(-2)}` : ''} · on ViciDial</div>
      {state.blocked && !clicked ? (
        <div className="notice" style={{ margin: '6px 0' }} data-testid="vici-blocked">
          <b>Allow pop-ups for {popupHost()}</b>, so ViciDial can be asked to dial. For now, click once:{' '}
          <a href={state.dialUrl || '#'} onClick={(e) => { e.preventDefault(); if (state.dialUrl && openFromClick(state.dialUrl, state.closeAfterMs || 4000)) setClicked(true); }}>Dial on ViciDial</a>
        </div>
      ) : (
        <div style={{ margin: '6px 0' }} data-testid="vici-sent">
          <b style={{ color: '#067647' }}>{state.saved ? 'Saved' : 'Sent to ViciDial'}</b>
          <div className="small-muted">{state.saved ? `On the call history: ${(state.record && state.record.outcomeNote) || pick}.` : 'Talk on the ViciDial agent screen as usual. The call is recorded in ViciDial. Then say how it went:'}</div>
        </div>
      )}
      {!state.saved && (
        <>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '4px 0' }}>
            {OUTCOMES.map((o) => <button key={o} type="button" className={`btn btn-sm${pick === o ? ' btn-primary' : ''}`} onClick={() => setPick(o)}>{o}</button>)}
          </div>
          <input aria-label="Note" placeholder="Note (optional)" value={note} maxLength={240} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', margin: '4px 0' }} />
        </>
      )}
      {state.error && <div className="small-muted" style={{ color: '#b42318', marginBottom: 4 }}>{state.error}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {!state.saved && <button type="button" className="btn btn-sm btn-primary" disabled={!pick || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
        <button type="button" className="btn btn-sm" onClick={dismiss}>Close</button>
      </div>
    </div>
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
        <MyCallingNumber />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => call({ candidateId: state.candidateId, applicationId: state.applicationId, name: state.name, outreachTaskId: state.outreachTaskId })}>{'☎'} Call</button>
          <button type="button" className="btn btn-sm" onClick={dismiss}>Cancel</button>
        </div>
      </div>
    );
  }
  if (state.phase === 'vici') return <ViciPanel state={state} box={box} dismiss={dismiss} />;
  if (state.phase === 'incoming') return <IncomingPanel state={state} box={box} />;
  const inbound = state.direction === 'inbound';
  const live = ['starting', 'calling', 'ringing', 'connected'].includes(state.phase);
  const rec = state.record;
  const why = ['failed', 'missed'].includes(state.phase) ? (state.error || (rec && rec.hangupReason)) : (state.phase === 'ended' && rec && rec.talkSec != null ? `Talk time ${mmss(rec.talkSec)}` : '');
  return (
    <div role="status" style={box} data-testid="call-bar">
      <div style={{ fontWeight: 600 }}>{state.name || 'Candidate'}</div>
      <div className="small-muted">{inbound ? `Incoming · ${state.maskedNumber || ''}` : (state.number ? `${state.number.slice(0, 2)}XXXXXX${state.number.slice(-2)}` : '')}{state.lineName ? ` · on ${state.lineName}` : ''}</div>
      {!inbound && <MyCallingNumber lineName={state.lineName} />}
      <div style={{ margin: '6px 0', fontSize: 15 }}>
        <b style={{ color: ['failed', 'missed'].includes(state.phase) ? '#b42318' : state.phase === 'connected' ? '#067647' : undefined }}>{WORD[state.phase]}</b>
        {state.phase === 'connected' && <span style={{ marginLeft: 8 }}>{mmss(seconds)}{state.held ? ' · On hold' : ''}{state.muted ? ' · Muted' : ''}</span>}
      </div>
      {why && <div className="small-muted" style={{ marginBottom: 6 }}>{why}</div>}
      {!live && !inbound && <LineSelect />}
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

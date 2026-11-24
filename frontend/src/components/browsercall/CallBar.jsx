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
const PHONE_TONE = { connected: '#067647', reconnecting: '#b54708', disconnected: '#667085', unavailable: '#b42318' };
// the paired Android phone(s) this person may use: live status + Connect / Disconnect / Reconnect (the ATS side of the link)
export function PhoneLinkControls() {
  const { lines, phoneLink } = useBrowserCall();
  const [busy, setBusy] = useState('');
  const phones = (lines || []).filter((l) => l.phone);
  if (!phones.length) return null;
  const act = async (l, a) => { setBusy(`${l.id}:${a}`); await phoneLink(l.deviceId, a); setBusy(''); };
  return (
    <div style={{ margin: '0 0 8px' }} data-testid="phone-link-controls">
      {phones.map((l) => (
        <div key={l.id} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{l.name}: <b style={{ color: PHONE_TONE[l.phoneStatus] }} data-testid="phone-status-chip">{l.phoneStatusWord}</b></span>
          {l.phoneStatus === 'disconnected'
            ? <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(l, 'connect')}>Connect</button>
            : <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(l, 'disconnect')}>Disconnect</button>}
          {['reconnecting', 'unavailable'].includes(l.phoneStatus) && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(l, 'reconnect')}>Reconnect</button>}
        </div>
      ))}
    </div>
  );
}

export function LineSelect({ disabled = false }) {
  const { lines, line, chooseLine } = useBrowserCall();
  if (!lines || lines.length === 0) return null;
  // a line that is listed but not usable yet (ViciDial before an Admin switches it on, or without your agent ID) is shown greyed with the reason
  const notReady = lines.filter((l) => l.ready === false && l.reason);
  return (
    <label className="field" style={{ margin: '4px 0 8px', display: 'block' }}>
      <span>Call using</span>
      <select aria-label="Call using" value={line ? line.id : ''} disabled={disabled || lines.filter((l) => l.ready !== false).length < 2} onChange={(e) => chooseLine(e.target.value)} style={{ width: '100%' }}>
        {lines.map((l) => <option key={l.id} value={l.id} disabled={l.ready === false}>{l.vicidial ? `ViciDial${l.ready === false ? ' (not connected yet)' : ' · on your ViciDial agent screen'}` : (l.phone ? `${l.name} · Android phone (${l.phoneStatusWord || (l.ready ? 'Connected' : 'not connected')})` : `${l.name}${l.builtIn ? '' : ` · ${l.typeLabel}`}`)}</option>)}
      </select>
      {notReady.map((l) => <span key={l.id} className="small-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }} data-testid={`line-reason-${l.id}`}>{l.name}: {l.reason}</span>)}
      {line && line.phone && <span className="small-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }} data-testid="phone-line-note">The phone {line.name.replace(/^Mobile /, '')} dials from its own SIM: talk on that phone (or its Bluetooth headset). Not recorded.</span>}
      {line && line.vicidial && <span className="small-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }}>ViciDial dials on your ViciDial agent screen: be logged in there. Recorded in ViciDial.</span>}
    </label>
  );
}

const OUTCOMES = ['Connected', 'No answer', 'Busy', 'Wrong number'];

// ANDROID PHONE LINK: what the phone really reported, a Hang up while it is on, then the notes (status, remarks, follow-up date, next action)
const PHONE_WORD = { requested: 'Call initiated', initiated: 'Sent to the phone', calling: 'On the phone (dialling / talking)', completed: 'Call completed', missed: 'Not answered / busy', busy: 'Busy', failed: 'Call failed', cancelled: 'Cancelled' };
const PHONE_LIVE = ['requested', 'initiated', 'calling'];
const NEXT_ACTIONS = ['Call again', 'Send details on WhatsApp', 'Schedule interview', 'Share with client', 'Not interested', 'Wrong number', 'Other'];
const PHONE_OUTCOMES = ['Connected', 'Not Answered', 'Busy', 'Call Failed'];
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
function PhonePanel({ state, box, seconds, dismiss }) {
  const { phoneHangup, phoneNotes } = useBrowserCall();
  const rec = state.record || {};
  const st = rec.status || 'requested';
  const live = PHONE_LIVE.includes(st) && !state.error;
  const guess = st === 'completed' ? 'Connected' : st === 'missed' ? 'Not Answered' : st === 'busy' ? 'Busy' : st === 'failed' ? 'Call Failed' : '';
  const [outcome, setOutcome] = useState('');
  const [remarks, setRemarks] = useState('');
  const [fu, setFu] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = outcome || guess;
  const save = async () => { setBusy(true); await phoneNotes({ outcome: pick, remarks, followUpDate: fu, nextAction: next }); setBusy(false); };
  const red = ['failed', 'missed', 'busy', 'cancelled'].includes(st) || state.error;
  return (
    <div role="status" style={{ ...box, width: 300 }} data-testid="call-bar">
      <div style={{ fontWeight: 600 }}>{state.name || 'Candidate'}</div>
      <div className="small-muted">{state.number ? `${state.number.slice(0, 2)}XXXXXX${state.number.slice(-2)}` : ''}{state.lineName ? ` · on ${state.lineName}` : ''}</div>
      <div style={{ margin: '6px 0', fontSize: 15 }} data-testid="phone-status">
        <b style={{ color: red ? '#b42318' : st === 'completed' ? '#067647' : undefined }}>{state.error ? 'Call failed' : (PHONE_WORD[st] || st)}</b>
        {st === 'calling' && <span style={{ marginLeft: 8 }}>{mmss(seconds)}</span>}
      </div>
      {state.error && <div className="small-muted" style={{ color: '#b42318', marginBottom: 4 }}>{state.error}</div>}
      {!state.error && st === 'calling' && <div className="small-muted" style={{ marginBottom: 4 }}>Talk on the phone. TeamLink shows the real talk time when the call ends.</div>}
      {!state.error && !live && rec.talkSec != null && <div className="small-muted" style={{ marginBottom: 4 }}>{rec.talkSec > 0 ? `Talk time ${mmss(rec.talkSec)} (from the phone's call log)` : (rec.hangupReason || 'No talk time')}</div>}
      {!state.error && !live && rec.talkSec == null && rec.hangupReason && <div className="small-muted" style={{ marginBottom: 4 }}>{rec.hangupReason}</div>}
      {!live && !state.error && rec.id && !state.saved && (
        <div data-testid="phone-notes" style={{ borderTop: '1px solid var(--border, #e4e7ec)', paddingTop: 6, marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '2px 0 4px' }}>
            {PHONE_OUTCOMES.map((o) => <button key={o} type="button" className={`btn btn-sm${pick === o ? ' btn-primary' : ''}`} onClick={() => setOutcome(o)} disabled={rec.status === 'completed' && o !== 'Connected'}>{o}</button>)}
          </div>
          <textarea aria-label="Call remarks" placeholder="Remarks (what was said)" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} rows={2} style={{ width: '100%', margin: '2px 0' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <label className="small-muted" style={{ flex: 1 }}>Follow-up date<input type="date" aria-label="Follow-up date" min={istToday()} value={fu} onChange={(e) => setFu(e.target.value)} style={{ width: '100%' }} /></label>
            <label className="small-muted" style={{ flex: 1 }}>Next action
              <select aria-label="Next action" value={next} onChange={(e) => setNext(e.target.value)} style={{ width: '100%' }}>
                <option value="">—</option>
                {NEXT_ACTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}
      {state.saved && <div className="small-muted" style={{ color: '#067647', marginBottom: 4 }} data-testid="phone-saved">Saved on the call history.{state.savedNote ? ` ${state.savedNote}` : ''}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {live && <button type="button" className="btn btn-sm" style={{ background: '#b42318', color: '#fff' }} onClick={phoneHangup}>{st === 'calling' ? 'Hang up on the phone' : 'Cancel'}</button>}
        {!live && !state.error && rec.id && !state.saved && <button type="button" className="btn btn-sm btn-primary" disabled={busy || !pick} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
        {!live && <button type="button" className="btn btn-sm" onClick={dismiss}>Close</button>}
      </div>
    </div>
  );
}
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
        <PhoneLinkControls />
        <MyCallingNumber />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => call({ candidateId: state.candidateId, applicationId: state.applicationId, name: state.name, outreachTaskId: state.outreachTaskId })}>{'☎'} Call</button>
          <button type="button" className="btn btn-sm" onClick={dismiss}>Cancel</button>
        </div>
      </div>
    );
  }
  if (state.phase === 'vici') return <ViciPanel state={state} box={box} dismiss={dismiss} />;
  if (state.phase === 'phone') return <PhonePanel key={state.callId || 'phone'} state={state} box={box} seconds={seconds} dismiss={dismiss} />;
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

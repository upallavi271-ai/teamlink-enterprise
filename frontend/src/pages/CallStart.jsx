import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import BrowserCallProvider, { useBrowserCall } from '../components/browsercall/CallProvider.jsx';
import CallBar from '../components/browsercall/CallBar.jsx';

// /call-start?candidateId=<id>&applicationId=<id>&name=<name>
// A bare page (no sidebar) for starting ONE manual browser call from somewhere that cannot use the softphone itself - the Job Portal app opens it in a new tab.
// Same softphone, same server checks as everywhere (Off / Test / Live, allowed numbers, role, one live call, mic permission). The call starts on ONE click here, so the
// browser allows the microphone and the sound of the call. Not signed in: ProtectedRoute sends the person to the login first.
function Inner() {
  const [q] = useSearchParams();
  const phone = (q.get('phone') || '').trim();
  const [found, setFound] = useState(null); // { id, name } by phone | { error }
  const candidateId = found && found.id ? found.id : (phone && !found ? '' : (q.get('candidateId') || '').trim());
  const applicationId = (q.get('applicationId') || '').trim() || undefined;
  const name = (q.get('name') || '').trim() || (found && found.name) || 'Candidate';
  const embed = q.get('embed') === '1'; // shown inside a small panel of the Job Portal page (an iframe on the same site): no big card
  const auto = q.get('auto') === '1'; // starts by itself: the person already clicked Call in the page that opened this panel
  const { available, info, state, call } = useBrowserCall();
  const started = useRef(false);
  useEffect(() => { // tell the page around this panel how the call is going, so it can close the panel when the call is over
    if (!embed || !window.parent || window.parent === window) return;
    try { window.parent.postMessage({ type: 'tl-browser-call', phase: state.phase, callId: state.callId || null }, window.location.origin); } catch { /* no parent */ }
  }, [embed, state.phase, state.callId]);
  // the Job Portal app knows people by its own ids: with ?phone= the TeamLink candidate is found by that number (same access rules)
  useEffect(() => {
    if (!phone || !available) return;
    api.get('/browser-calling/lookup', { params: { phone } }).then((r) => setFound(r.data.candidate))
      .catch((e) => { const fb = (q.get('candidateId') || '').trim(); setFound(fb ? { id: fb } : { error: (e.response && e.response.data && e.response.data.error) || 'Could not find this person in TeamLink.' }); });
  }, [phone, available]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = ['starting', 'calling', 'ringing', 'connected'].includes(state.phase);
  const over = ['ended', 'failed'].includes(state.phase);
  useEffect(() => {
    if (!auto || started.current || !available || !candidateId || state.phase !== 'idle') return;
    started.current = true;
    call({ candidateId, applicationId, name });
  }, [auto, available, candidateId, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  let body;
  if (!candidateId && !phone) body = <div className="notice red">No candidate was given. Open this from a candidate in the Job Portal or TeamLink.</div>;
  else if (found && found.error) body = <div className="notice red">{found.error}</div>;
  else if (!info) body = <div className="small-muted">Checking that browser calling is on for your login…</div>;
  else if (!available) body = <div className="notice red">{info.reason || 'Browser calling is switched off, or your login may not use it. Ask an Admin.'}</div>;
  else if (!candidateId) body = <div className="small-muted">Finding this person in TeamLink…</div>;
  else {
    body = (
      <>
        <div className="small-muted" style={{ marginBottom: 12 }}>{info.testMode ? 'Test mode: only the Admin\'s test numbers can be called.' : 'The call goes out from the SIM line, straight from this browser.'}</div>
        {!live && !over && <button type="button" className="btn btn-primary" onClick={() => call({ candidateId, applicationId, name })}>{'☎'} Start call</button>}
        {!live && over && <button type="button" className="btn" onClick={() => call({ candidateId, applicationId, name })}>{'☎'} Call again</button>}
        {over && <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => window.close()}>Close this tab</button>}
      </>
    );
  }
  return (
    <div style={embed ? { padding: 8 } : { maxWidth: 420, margin: '12vh auto', padding: '0 16px' }}>
      <div className="card section" style={{ padding: embed ? 12 : 20, display: embed && state.phase !== 'idle' && state.phase !== 'choose' ? 'none' : undefined }}>
        <div className="section-label">Call from browser</div>
        <h2 style={{ margin: '4px 0 12px', fontSize: embed ? 16 : undefined }}>{name}</h2>
        {body}
      </div>
      <CallBar />
    </div>
  );
}

export default function CallStart() {
  return <BrowserCallProvider><Inner /></BrowserCallProvider>;
}

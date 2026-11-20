import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UserAgent, Registerer, Inviter, SessionState, Web } from 'sip.js';
import api from '../../api';

// MANUAL BROWSER CALLING (SIP.js over WSS -> Asterisk -> Synway SIM). One softphone for the whole app.
// The SIP password is fetched per session from the server (POST /browser-calling/session), kept only in memory, never stored.
// Status words come from what really happens: SIP progress in this browser, then the server's row (written from Asterisk events).
const Ctx = createContext(null);
export const useBrowserCall = () => useContext(Ctx) || { available: false, state: { phase: 'idle' }, call: () => {}, hangup: () => {}, toggleMute: () => {}, toggleHold: () => {} };

const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

export default function BrowserCallProvider({ children }) {
  const [info, setInfo] = useState(null); // GET /status
  const [state, setState] = useState({ phase: 'idle' }); // idle | starting | calling | ringing | connected | failed | ended
  const [seconds, setSeconds] = useState(0);
  const ua = useRef(null); const reg = useRef(null); const sess = useRef(null); const audioEl = useRef(null); const poll = useRef(null); const tick = useRef(null);
  const creds = useRef(null);

  useEffect(() => { api.get('/browser-calling/status').then((r) => setInfo(r.data)).catch(() => setInfo({ canCall: false })); }, []);
  useEffect(() => () => { try { if (ua.current) ua.current.stop(); } catch { /* closing */ } clearInterval(poll.current); clearInterval(tick.current); }, []);

  const stopTimers = () => { clearInterval(poll.current); clearInterval(tick.current); };
  const finish = useCallback((phase, extra = {}) => {
    stopTimers();
    setState((s) => ({ ...s, phase, muted: false, held: false, ...extra }));
  }, []);

  const ensureUa = useCallback(async () => {
    if (ua.current && ua.current.isConnected() && reg.current && creds.current && Date.parse(creds.current.expiresAt) > Date.now() + 60000) return;
    if (ua.current) { try { await ua.current.stop(); } catch { /* old */ } ua.current = null; }
    const { data } = await api.post('/browser-calling/session');
    creds.current = { expiresAt: data.expiresAt };
    const uri = UserAgent.makeURI(`sip:${data.extension}@${data.domain}`);
    const agent = new UserAgent({
      uri, displayName: data.displayName, authorizationUsername: data.authUser, authorizationPassword: data.password,
      transportOptions: { server: data.wssUrl }, logLevel: 'error',
      sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: data.iceServers || [] } },
    });
    await agent.start();
    const registerer = new Registerer(agent);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The phone system did not accept this login in time (registration).')), 12000);
      registerer.stateChange.addListener((s) => { if (s === 'Registered') { clearTimeout(t); resolve(); } });
      registerer.register({ requestDelegate: { onReject: (r) => { clearTimeout(t); reject(new Error(`Phone registration refused (${r.message.statusCode}).`)); } } }).catch((e) => { clearTimeout(t); reject(e); });
    });
    ua.current = agent; reg.current = registerer; creds.current.domain = data.domain;
  }, []);

  const attachAudio = (session) => {
    const pc = session.sessionDescriptionHandler && session.sessionDescriptionHandler.peerConnection;
    if (!pc) return;
    const ms = new MediaStream();
    pc.getReceivers().forEach((r) => { if (r.track) ms.addTrack(r.track); });
    if (!audioEl.current) { audioEl.current = document.createElement('audio'); audioEl.current.autoplay = true; document.body.appendChild(audioEl.current); }
    audioEl.current.srcObject = ms;
    audioEl.current.play().catch(() => {});
  };

  const call = useCallback(async ({ candidateId, applicationId, name }) => {
    if (sess.current) { setState((s) => ({ ...s, note: 'A call is already in progress.' })); return; }
    setState({ phase: 'starting', name, candidateId });
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop()));
    } catch { setState({ phase: 'failed', name, candidateId, error: 'The microphone is blocked. Allow the microphone for this site and try again.' }); return; }
    let placed;
    try {
      await ensureUa();
      placed = (await api.post('/browser-calling/calls', { candidateId, applicationId })).data;
    } catch (e) { setState({ phase: 'failed', name, candidateId, error: errOf(e, e.message || 'Could not start the call.') }); return; }
    const target = UserAgent.makeURI(`sip:${placed.number}@${creds.current.domain}`);
    const inviter = new Inviter(ua.current, target, { extraHeaders: [`X-TL-Call: ${placed.token}`], sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    sess.current = inviter;
    setSeconds(0);
    setState({ phase: 'calling', name: placed.candidate.name, candidateId, callId: placed.callId, number: placed.number });
    let answeredAt = null;
    inviter.stateChange.addListener((s) => {
      if (s === SessionState.Established) {
        answeredAt = Date.now(); attachAudio(inviter);
        setState((x) => ({ ...x, phase: 'connected' }));
        clearInterval(tick.current); tick.current = setInterval(() => setSeconds(Math.round((Date.now() - answeredAt) / 1000)), 500);
      } else if (s === SessionState.Terminated) {
        sess.current = null;
        setState((x) => (x.phase === 'connected' ? { ...x, phase: 'ended' } : (x.phase === 'failed' ? x : { ...x, phase: 'failed', error: x.error || 'The call did not connect.' })));
        stopTimers();
        // the server row (from Asterisk) has the true result: read it once more
        setTimeout(() => api.get(`/browser-calling/calls/${placed.callId}`).then((r) => setState((x) => ({ ...x, record: r.data.call }))).catch(() => {}), 1500);
      }
    });
    clearInterval(poll.current);
    poll.current = setInterval(() => api.get(`/browser-calling/calls/${placed.callId}`).then((r) => setState((x) => ({ ...x, record: r.data.call }))).catch(() => {}), 3000);
    inviter.invite({
      requestDelegate: {
        onProgress: (r) => { if ([180, 183].includes(r.message.statusCode)) setState((x) => (x.phase === 'calling' ? { ...x, phase: 'ringing' } : x)); },
        onReject: (r) => setState((x) => ({ ...x, phase: 'failed', error: `${r.message.statusCode} ${r.message.reasonPhrase || ''}`.trim() })),
      },
    }).catch((e) => { sess.current = null; finish('failed', { error: e.message || 'The call could not be sent.' }); });
  }, [ensureUa, finish]);

  const hangup = useCallback(() => {
    const s = sess.current;
    if (!s) { setState({ phase: 'idle' }); return; }
    try { if (s.state === SessionState.Established) s.bye(); else s.cancel(); } catch { /* already over */ }
  }, []);

  const toggleMute = useCallback(() => {
    const s = sess.current; const pc = s && s.sessionDescriptionHandler && s.sessionDescriptionHandler.peerConnection;
    if (!pc) return;
    setState((x) => {
      const muted = !x.muted;
      pc.getSenders().forEach((snd) => { if (snd.track && snd.track.kind === 'audio') snd.track.enabled = !muted; });
      return { ...x, muted };
    });
  }, []);

  const toggleHold = useCallback(async () => {
    const s = sess.current;
    if (!s || s.state !== SessionState.Established) return;
    const hold = !state.held;
    try {
      await s.invite({ sessionDescriptionHandlerModifiers: hold ? [Web.holdModifier] : [] });
      setState((x) => ({ ...x, held: hold }));
    } catch { setState((x) => ({ ...x, note: 'Hold did not work.' })); }
  }, [state.held]);

  const dismiss = useCallback(() => setState({ phase: 'idle' }), []);
  const value = useMemo(() => ({ available: !!(info && info.canCall), info, state, seconds, call, hangup, toggleMute, toggleHold, dismiss }), [info, state, seconds, call, hangup, toggleMute, toggleHold, dismiss]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

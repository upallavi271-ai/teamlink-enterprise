import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UserAgent, Registerer, Inviter, SessionState, Web } from 'sip.js';
import api from '../../api';
import { openBlank, sendTo, closeBlank } from './vicidialPopup.js';

// MANUAL BROWSER CALLING (SIP.js over WSS -> Asterisk -> Synway SIM). One softphone for the whole app.
// The SIP password is fetched per session from the server (POST /browser-calling/session), kept only in memory, never stored.
// Status words come from what really happens: SIP progress in this browser, then the server's row (written from Asterisk events).
const Ctx = createContext(null);
export const useBrowserCall = () => useContext(Ctx) || { available: false, state: { phase: 'idle' }, lines: [], call: () => {}, pickAndCall: () => {}, testCall: () => {}, chooseLine: () => {}, hangup: () => {}, toggleMute: () => {}, toggleHold: () => {} };

const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
// PHONE LINES (2026-11-23): which line the call goes out on ("Call using"). The server lists the lines this login may use (GET /status) and decides
// the line of each call; the browser only sends the header value the server handed back. The last choice is remembered on this computer.
const LINE_KEY = 'tl_browser_call_line';
const savedLine = () => { try { return localStorage.getItem(LINE_KEY) || ''; } catch { return ''; } };

export default function BrowserCallProvider({ children }) {
  const [info, setInfo] = useState(null); // GET /status
  const [state, setState] = useState({ phase: 'idle' }); // idle | starting | calling | ringing | connected | failed | ended
  const [seconds, setSeconds] = useState(0);
  const [linePick, setLinePick] = useState(savedLine);
  const ua = useRef(null); const reg = useRef(null); const sess = useRef(null); const audioEl = useRef(null); const poll = useRef(null); const tick = useRef(null);
  const creds = useRef(null); const tone = useRef(null);
  const stopTone = () => { try { if (tone.current) { tone.current.osc.stop(); tone.current.ctx.close(); } } catch { /* done */ } tone.current = null; };
  const startTone = () => {
    if (tone.current) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); const gain = ctx.createGain(); gain.gain.value = 0;
      const osc = ctx.createOscillator(); osc.frequency.value = 425; osc.connect(gain); gain.connect(ctx.destination); osc.start();
      const beat = () => { const t = ctx.currentTime; gain.gain.setValueAtTime(0.12, t); gain.gain.setValueAtTime(0, t + 0.4); gain.gain.setValueAtTime(0.12, t + 0.6); gain.gain.setValueAtTime(0, t + 1.0); };
      beat(); const iv = setInterval(beat, 4000); osc.onended = () => clearInterval(iv); tone.current = { ctx, osc };
    } catch { /* no audio context */ }
  };

  const refresh = useCallback(() => api.get('/browser-calling/status').then((r) => setInfo(r.data)).catch(() => setInfo({ canCall: false })), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => () => { try { if (ua.current) ua.current.stop(); } catch { /* closing */ } clearInterval(poll.current); clearInterval(tick.current); }, []);

  const stopTimers = () => { clearInterval(poll.current); clearInterval(tick.current); stopTone(); };
  const finish = useCallback((phase, extra = {}) => {
    stopTimers();
    setState((s) => ({ ...s, phase, muted: false, held: false, ...extra }));
  }, []);

  // sessionPath: the CRM asks its own door (POST /crm/b/calls/session, CRM wave B) - a salesperson may have no ATS login
  const ensureUa = useCallback(async (sessionPath = '/browser-calling/session') => {
    if (ua.current && ua.current.isConnected() && reg.current && creds.current && Date.parse(creds.current.expiresAt) > Date.now() + 60000) return;
    if (ua.current) { try { await ua.current.stop(); } catch { /* old */ } ua.current = null; }
    const { data } = await api.post(sessionPath);
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

  const lines = useMemo(() => (info && info.lines) || [], [info]);
  // a line that is listed but not usable (ViciDial before it is switched on / without an agent ID) is never the one in use
  const usable = (l) => l && l.ready !== false;
  const curLine = lines.find((l) => l.id === linePick && usable(l)) || lines.find(usable) || null;
  const chooseLine = useCallback((id) => { setLinePick(id); try { localStorage.setItem(LINE_KEY, id); } catch { /* kept for this visit only */ } }, []);

  // one call, whatever asked for it: `placeIt` asks the server for the row (and the line), then the browser sends the INVITE
  const run = useCallback(async ({ candidateId, name }, placeIt, { sessionPath } = {}) => {
    if (sess.current) { setState((s) => ({ ...s, note: 'A call is already in progress.' })); return; }
    setState({ phase: 'starting', name, candidateId });
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop()));
    } catch { setState({ phase: 'failed', name, candidateId, error: 'The microphone is blocked. Allow the microphone for this site and try again.' }); return; }
    let placed;
    try {
      await ensureUa(sessionPath);
      placed = await placeIt();
    } catch (e) { setState({ phase: 'failed', name, candidateId, error: errOf(e, e.message || 'Could not start the call.') }); return; }
    const target = UserAgent.makeURI(`sip:${placed.number}@${creds.current.domain}`);
    const headers = [`X-TL-Call: ${placed.token}`];
    if (placed.line && placed.line.header) headers.push(`X-TL-Line: ${placed.line.header}`);
    const inviter = new Inviter(ua.current, target, { extraHeaders: headers, sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    sess.current = inviter;
    setSeconds(0);
    startTone();
    setState({ phase: 'calling', name: placed.candidate.name, candidateId, callId: placed.callId, number: placed.number, lineName: placed.line ? placed.line.name : '' });
    let answeredAt = null;
    inviter.stateChange.addListener((s) => {
      if (s === SessionState.Established) {
        stopTone(); answeredAt = Date.now(); attachAudio(inviter);
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

  // VICIDIAL click to dial: the server checks and answers with the one dial link; this browser opens it in a small popup (opened inside the
  // click, pointed at the link when the answer comes) and closes it after ~4 s. The recruiter talks on the ViciDial agent screen, then says how it went.
  const viciCall = useCallback(async ({ candidateId, applicationId, name }) => {
    if (sess.current) { setState((s) => ({ ...s, note: 'A call is already in progress.' })); return; }
    const w = openBlank();
    setState({ phase: 'starting', name, candidateId, vici: true, lineName: 'ViciDial' });
    let placed;
    try { placed = (await api.post('/browser-calling/vicidial/dial', { candidateId, applicationId })).data; } catch (e) {
      closeBlank(w);
      setState({ phase: 'failed', name, candidateId, vici: true, lineName: 'ViciDial', error: errOf(e, 'Could not ask ViciDial to dial.') });
      return;
    }
    const opened = sendTo(w, placed.dialUrl, placed.closeAfterMs || 4000);
    setState({ phase: 'vici', vici: true, name: placed.candidate.name, candidateId, callId: placed.callId, number: placed.number, lineName: 'ViciDial', blocked: !opened, dialUrl: opened ? null : placed.dialUrl, closeAfterMs: placed.closeAfterMs || 4000 });
  }, []);
  const viciOutcome = useCallback(async ({ outcome, note }) => {
    const id = state.callId;
    if (!id) return;
    try {
      const r = await api.post(`/browser-calling/vicidial/calls/${encodeURIComponent(id)}/outcome`, { outcome, note });
      setState((x) => ({ ...x, saved: true, dialUrl: null, blocked: false, record: r.data.call, error: null }));
    } catch (e) { setState((x) => ({ ...x, error: errOf(e, 'Could not save how the call went.') })); }
  }, [state.callId]);

  // a candidate call on the chosen line (or the one given)
  const call = useCallback(({ candidateId, applicationId, name, lineId, outreachTaskId }) => {
    const ln = lineId || (curLine && curLine.id) || undefined;
    if (ln === 'vicidial' && !outreachTaskId) return viciCall({ candidateId, applicationId, name });
    return run({ candidateId: candidateId || (outreachTaskId ? `task:${outreachTaskId}` : undefined), name }, async () => (await api.post('/browser-calling/calls', { candidateId, applicationId, lineId: ln, outreachTaskId })).data);
  }, [run, curLine, viciCall]);
  // CRM wave B: a lead / deal / customer of the CRM on the office line (POST /crm/b/calls; the row is kept as crm:<kind>:<id>)
  const callCrm = useCallback(({ kind, id, name, lineId, to }) => run({ candidateId: `crm:${kind}:${id}`, name }, async () => (await api.post('/crm/b/calls', { kind, id, to, lineId: lineId || (curLine && !curLine.vicidial ? curLine.id : undefined) || undefined })).data, { sessionPath: '/crm/b/calls/session' }), [run, curLine]);
  // "pick the line first": the call bar shows "Call using" and the Call button
  const pickAndCall = useCallback((args) => { if (!sess.current) setState({ phase: 'choose', ...args }); }, []);
  // Admin: a test call on one line to one of the Test numbers (Phone lines > Test call)
  const testCall = useCallback(({ lineId, number, lineName }) => run({ candidateId: 'test-call', name: `Test call · ${lineName || ''}` },
    async () => (await api.post(`/browser-calling/admin/lines/${encodeURIComponent(lineId)}/test-call`, { number })).data), [run]);

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
  const value = useMemo(() => ({ available: !!(info && info.canCall), info, state, seconds, lines, line: curLine, chooseLine, call, callCrm, pickAndCall, testCall, refresh, hangup, toggleMute, toggleHold, dismiss, viciOutcome }), [refresh, info, state, seconds, lines, curLine, chooseLine, call, callCrm, pickAndCall, testCall, hangup, toggleMute, toggleHold, dismiss, viciOutcome]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

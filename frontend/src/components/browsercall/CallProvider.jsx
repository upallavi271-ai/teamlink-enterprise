import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UserAgent, Registerer, Inviter, SessionState, Web } from 'sip.js';
import api from '../../api';
import { openBlank, sendTo, closeBlank } from './vicidialPopup.js';

// MANUAL BROWSER CALLING (SIP.js over WSS -> Asterisk -> Synway SIM). One softphone for the whole app.
// The SIP password is fetched per session from the server (POST /browser-calling/session), kept only in memory, never stored.
// Status words come from what really happens: SIP progress in this browser, then the server's row (written from Asterisk events).
const Ctx = createContext(null);
export const useBrowserCall = () => useContext(Ctx) || { available: false, state: { phase: 'idle' }, lines: [], mySim: null, call: () => {}, pickAndCall: () => {}, testCall: () => {}, chooseLine: () => {}, hangup: () => {}, toggleMute: () => {}, toggleHold: () => {}, answer: () => {}, decline: () => {} };

const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
// PHONE LINES (2026-11-23): which line the call goes out on ("Call using"). The server lists the lines this login may use (GET /status) and decides
// the line of each call; the browser only sends the header value the server handed back. The last choice is remembered on this computer.
const LINE_KEY = 'tl_browser_call_line';
const savedLine = () => { try { return localStorage.getItem(LINE_KEY) || ''; } catch { return ''; } };
// ONE SIM PER RECRUITER (2026-11-25): a person with a SIM port keeps the softphone registered while TeamLink is open, so a candidate calling
// that SIM back rings here. Only ONE tab of this browser registers (BroadcastChannel "tl-softphone": the tab that claimed first stays the
// "phone" until it closes; the others stand by and take over when it goes), so two tabs never both ring.
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const tokenOf = (inv) => { try { return String(inv.remoteIdentity.uri.user || '').toLowerCase(); } catch { return ''; } };

export default function BrowserCallProvider({ children }) {
  const [info, setInfo] = useState(null); // GET /status
  const [state, setState] = useState({ phase: 'idle' }); // idle | starting | calling | ringing | connected | failed | ended
  const [seconds, setSeconds] = useState(0);
  const [linePick, setLinePick] = useState(savedLine);
  const ua = useRef(null); const reg = useRef(null); const sess = useRef(null); const audioEl = useRef(null); const poll = useRef(null); const tick = useRef(null);
  const creds = useRef(null); const tone = useRef(null); const ringer = useRef(null); const phoneWanted = useRef(false);
  // a tab that is NOT the registered "phone" made a call (its registration replaced the phone tab's): after the call it lets go and tells
  // the phone tab to register again, so calls back to the SIM keep ringing there
  const handBack = () => {
    if (!phoneWanted.current || leader.current) return;
    setTimeout(() => {
      if (sess.current) return;
      if (ua.current) { try { ua.current.stop(); } catch { /* gone */ } ua.current = null; reg.current = null; }
      try { const c = new BroadcastChannel('tl-softphone'); c.postMessage({ t: 'kick', id: TAB_ID }); c.close(); } catch { /* no channel */ }
    }, 1500);
  };
  const incomingRef = useRef(() => {}); const leader = useRef(false); const [phoneState, setPhoneState] = useState('off'); // off | standby | connecting | ready | error
  // the incoming-call ring: two short tones, every 3 s (WebAudio, nothing downloaded)
  const stopRing = () => { try { if (ringer.current) { clearInterval(ringer.current.iv); ringer.current.ctx.close(); } } catch { /* done */ } ringer.current = null; };
  const startRing = () => {
    if (ringer.current) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(ctx.destination);
      [440, 480].forEach((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); });
      const beat = () => { const t = ctx.currentTime; gain.gain.setValueAtTime(0.08, t); gain.gain.setValueAtTime(0, t + 0.4); gain.gain.setValueAtTime(0.08, t + 0.6); gain.gain.setValueAtTime(0, t + 1.0); };
      beat(); ringer.current = { ctx, iv: setInterval(beat, 3000) };
    } catch { /* no audio context */ }
  };
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

  const stopTimers = () => { clearInterval(poll.current); clearInterval(tick.current); stopTone(); stopRing(); };
  const finish = useCallback((phase, extra = {}) => {
    stopTimers();
    setState((s) => ({ ...s, phase, muted: false, held: false, ...extra }));
  }, []);

  // sessionPath: the CRM asks its own door (POST /crm/b/calls/session, CRM wave B) - a salesperson may have no ATS login
  const ensureUa = useCallback(async (sessionPath = '/browser-calling/session') => {
    if (ua.current && ua.current.isConnected() && reg.current && reg.current.state === 'Registered' && creds.current && Date.parse(creds.current.expiresAt) > Date.now() + 60000) return;
    if (ua.current) { try { await ua.current.stop(); } catch { /* old */ } ua.current = null; }
    const { data } = await api.post(sessionPath);
    creds.current = { expiresAt: data.expiresAt };
    const uri = UserAgent.makeURI(`sip:${data.extension}@${data.domain}`);
    const agent = new UserAgent({
      uri, displayName: data.displayName, authorizationUsername: data.authUser, authorizationPassword: data.password,
      transportOptions: { server: data.wssUrl, keepAliveInterval: 30 }, logLevel: 'error',
      sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: data.iceServers || [] } },
      delegate: { onInvite: (invitation) => incomingRef.current(invitation) }, // a candidate calling the person's SIM back (browsercall/sims.js)
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
        handBack();
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

  // ANDROID PHONE LINK: the server queues the call for the paired phone, the phone dials it from its own SIM and reports. This browser only
  // shows what the phone really said (Call initiated -> Sent to phone -> On the phone -> Completed / Not answered / Failed), then the notes form.
  const PHONE_LIVE = ['requested', 'initiated', 'calling'];
  const phoneCall = useCallback(async ({ candidateId, applicationId, name, lineId, lineName }) => {
    if (sess.current) { setState((s) => ({ ...s, note: 'A call is already in progress.' })); return; }
    setState({ phase: 'phone', phone: true, name, candidateId, lineName, record: { status: 'requested' } });
    let placed;
    try { placed = (await api.post('/browser-calling/phone/calls', { candidateId, applicationId, lineId })).data; } catch (e) {
      setState({ phase: 'phone', phone: true, name, candidateId, lineName, record: { status: 'failed' }, error: errOf(e, 'Could not send the call to the phone.') });
      return;
    }
    setState({ phase: 'phone', phone: true, name: placed.candidate.name, candidateId, applicationId, callId: placed.callId, number: placed.number, lineName: placed.line.name, record: { status: 'requested' } });
    setSeconds(0);
    clearInterval(poll.current); clearInterval(tick.current);
    let onAt = null;
    const read = () => api.get(`/browser-calling/calls/${placed.callId}`).then((r) => {
      const c = r.data.call;
      if (c.status === 'calling' && !onAt) { onAt = Date.now(); clearInterval(tick.current); tick.current = setInterval(() => setSeconds(Math.round((Date.now() - onAt) / 1000)), 500); }
      if (!PHONE_LIVE.includes(c.status)) { clearInterval(poll.current); clearInterval(tick.current); }
      setState((x) => (x.callId === placed.callId ? { ...x, record: c } : x));
    }).catch(() => {});
    poll.current = setInterval(read, 2000);
    read();
  }, []);
  const phoneHangup = useCallback(async () => {
    const id = state.callId; if (!id) { setState({ phase: 'idle' }); return; }
    try { const r = await api.post(`/browser-calling/phone/calls/${encodeURIComponent(id)}/hangup`); setState((x) => ({ ...x, record: r.data.call })); } catch (e) { setState((x) => ({ ...x, error: errOf(e, 'Could not hang up.') })); }
  }, [state.callId]);
  const phoneNotes = useCallback(async (notes) => {
    const id = state.callId; if (!id) return false;
    try {
      const r = await api.post(`/browser-calling/phone/calls/${encodeURIComponent(id)}/outcome`, notes);
      setState((x) => ({ ...x, record: r.data.call, saved: true, savedNote: r.data.followUpSkipped || (r.data.followUp ? `Follow-up added for ${r.data.followUp.dueDate}.` : ''), error: null }));
      return true;
    } catch (e) { setState((x) => ({ ...x, error: errOf(e, 'Could not save the call notes.') })); return false; }
  }, [state.callId]);
  const phoneLink = useCallback(async (deviceId, action) => {
    try { await api.post(`/browser-calling/phone/devices/${encodeURIComponent(deviceId)}/${action}`); } catch (e) { /* shown by the status */ }
    return refresh();
  }, [refresh]);

  // a candidate call on the chosen line (or the one given)
  const call = useCallback(({ candidateId, applicationId, name, lineId, outreachTaskId }) => {
    const ln = lineId || (curLine && curLine.id) || undefined;
    if (ln === 'vicidial' && !outreachTaskId) return viciCall({ candidateId, applicationId, name });
    const pl = lines.find((l) => l.id === ln && l.phone);
    if (pl && pl.bridge && !outreachTaskId) return run({ candidateId, name }, async () => (await api.post('/browser-calling/phone/bridge-calls', { candidateId, applicationId, lineId: pl.id })).data);
    if (pl && !outreachTaskId) return phoneCall({ candidateId, applicationId, name, lineId: pl.id, lineName: pl.name });
    return run({ candidateId: candidateId || (outreachTaskId ? `task:${outreachTaskId}` : undefined), name }, async () => (await api.post('/browser-calling/calls', { candidateId, applicationId, lineId: ln === 'vicidial' ? undefined : ln, outreachTaskId })).data);
  }, [run, curLine, viciCall, phoneCall, lines]);
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
    try { if (s.state === SessionState.Established) s.bye(); else if (typeof s.reject === 'function') s.reject(); else s.cancel(); } catch { /* already over */ }
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

  // ---------------------------------------------------------------- INCOMING: a candidate calls the person's SIM back
  // The phone system puts the call's token in the caller ID (never the number); the server says who it is (scope-checked, number masked).
  const mySim = (info && info.canCall && info.sim) || null;
  const onIncoming = useCallback((invitation) => {
    if (sess.current) { try { invitation.reject({ statusCode: 486 }); } catch { /* gone */ } return; } // already on a call: busy (the call shows as missed)
    const token = tokenOf(invitation);
    sess.current = invitation;
    setSeconds(0);
    startRing();
    setState({ phase: 'incoming', direction: 'inbound', name: 'Incoming call', number: '', token, lineName: mySim ? `your SIM ${mySim.number}` : 'the office line' });
    let tries = 0;
    const who = () => api.get(`/browser-calling/incoming/${encodeURIComponent(token)}`).then((r) => {
      const d = r.data;
      setState((x) => (x.token !== token ? x : { ...x, callId: d.callId, maskedNumber: d.number, name: d.candidate ? d.candidate.name : 'Unknown caller', candidateId: d.candidate ? d.candidate.id : null, requirement: d.candidate ? d.candidate.requirement : null, lineName: d.lineName || x.lineName }));
    }).catch(() => { tries += 1; if (tries < 4) setTimeout(who, 700); else setState((x) => (x.token !== token ? x : { ...x, name: 'Unknown caller' })); });
    if (/^in\d+$/.test(token)) who(); else setState((x) => ({ ...x, name: 'Unknown caller' }));
    let answeredAt = null;
    invitation.stateChange.addListener((st) => {
      if (st === SessionState.Established) {
        stopRing(); answeredAt = Date.now(); attachAudio(invitation);
        setState((x) => ({ ...x, phase: 'connected' }));
        clearInterval(tick.current); tick.current = setInterval(() => setSeconds(Math.round((Date.now() - answeredAt) / 1000)), 500);
      } else if (st === SessionState.Terminated) {
        sess.current = null; stopTimers();
        setState((x) => (x.phase === 'connected' ? { ...x, phase: 'ended' } : { ...x, phase: 'missed', error: x.declined ? 'You declined the call. It is in the call history as missed.' : 'The caller hung up before it was answered. It is in the call history as missed.' }));
        setTimeout(() => setState((x) => { if (x.callId) api.get(`/browser-calling/calls/${x.callId}`).then((r) => setState((y) => ({ ...y, record: r.data.call }))).catch(() => {}); return x; }), 1500);
      }
    });
  }, [mySim]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { incomingRef.current = onIncoming; }, [onIncoming]);
  // the browser smoke test (scripts/sim-per-recruiter-browser.js) rings this tab with a fake session: window.__tlSoftphone.incoming(fake)
  useEffect(() => { window.__tlSoftphone = { incoming: (inv) => incomingRef.current(inv), state: () => ({ leader: leader.current, phone: phoneState }) }; return () => { delete window.__tlSoftphone; }; }, [phoneState]);

  const answer = useCallback(async () => {
    const s = sess.current;
    if (!s || state.phase !== 'incoming') return;
    stopRing();
    try { await s.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } }); } catch (e) { setState((x) => ({ ...x, note: (e && e.message) || 'Could not answer (is the microphone allowed?).' })); }
  }, [state.phase]);
  const decline = useCallback(() => {
    const s = sess.current;
    if (!s) return;
    stopRing();
    setState((x) => ({ ...x, declined: true }));
    try { s.reject({ statusCode: 486 }); } catch { /* gone */ }
  }, []);

  // ---------------------------------------------------------------- stay registered while TeamLink is open (a person with a SIM)
  const wantPhone = !!((mySim || (info && info.canCall && info.inbound)) && info && info.wssConfigured);
  useEffect(() => {
    phoneWanted.current = wantPhone;
    if (!wantPhone) { setPhoneState('off'); return undefined; }
    let alive = true; let lastLeaderSeen = 0; let backoff = 30000; let nextTry = 0;
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tl-softphone') : null;
    const post = (m) => { try { if (bc) bc.postMessage({ ...m, id: TAB_ID }); } catch { /* closed */ } };
    const keep = async () => {
      if (!alive || !leader.current || Date.now() < nextTry) return;
      if (ua.current && ua.current.isConnected() && reg.current && reg.current.state === 'Registered' && creds.current && Date.parse(creds.current.expiresAt) > Date.now() + 120000) { setPhoneState('ready'); return; }
      if (sess.current) return; // never re-register in the middle of a call
      setPhoneState('connecting');
      try { await ensureUa(); if (alive) { setPhoneState('ready'); backoff = 30000; } } catch { if (alive) { setPhoneState('error'); nextTry = Date.now() + backoff; backoff = Math.min(backoff * 2, 600000); } }
    };
    const claim = () => { if (!alive || leader.current) return; leader.current = true; post({ t: 'leader' }); keep(); };
    const stepDown = () => { if (!leader.current) return; leader.current = false; setPhoneState('standby'); if (!sess.current && reg.current) { try { reg.current.unregister().catch(() => {}); } catch { /* gone */ } } };
    if (bc) {
      bc.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.id === TAB_ID) return;
        if (m.t === 'who' && leader.current) post({ t: 'leader' });
        if (m.t === 'leader') { lastLeaderSeen = Date.now(); if (leader.current && String(m.id) < TAB_ID) stepDown(); else if (leader.current) post({ t: 'leader' }); }
        if (m.t === 'kick' && leader.current && !sess.current) { if (ua.current) { try { ua.current.stop(); } catch { /* gone */ } ua.current = null; reg.current = null; } nextTry = 0; keep(); }
        if (m.t === 'bye') { lastLeaderSeen = 0; setTimeout(() => { if (!lastLeaderSeen) claim(); }, Math.round(Math.random() * 400)); }
      };
      setPhoneState('standby');
      post({ t: 'who' });
      setTimeout(() => { if (!lastLeaderSeen) claim(); }, 700);
    } else claim();
    const beat = setInterval(() => {
      if (leader.current) { post({ t: 'leader' }); keep(); } else if (Date.now() - lastLeaderSeen > 9000) claim();
    }, 3000);
    const bye = () => { if (leader.current) post({ t: 'bye' }); };
    window.addEventListener('pagehide', bye);
    return () => { alive = false; bye(); clearInterval(beat); window.removeEventListener('pagehide', bye); leader.current = false; try { if (bc) bc.close(); } catch { /* closed */ } };
  }, [wantPhone, ensureUa]);

  const value = useMemo(() => ({ available: !!(info && info.canCall), info, state, seconds, lines, line: curLine, mySim, phoneState, chooseLine, call, callCrm, pickAndCall, testCall, refresh, hangup, toggleMute, toggleHold, dismiss, viciOutcome, answer, decline, phoneHangup, phoneNotes, phoneLink }), [refresh, info, state, seconds, lines, curLine, mySim, phoneState, chooseLine, call, callCrm, pickAndCall, testCall, hangup, toggleMute, toggleHold, dismiss, viciOutcome, answer, decline, phoneHangup, phoneNotes, phoneLink]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------------------
// THE CANDIDATE'S FREE AI LINK (2026-10-28) — opened from the WhatsApp message the
// recruiter sends. No login: the token is the key (backend routes/aiTalk.js,
// calling/webTalk.js). The SAME assistant as AI calling, on a web page: ₹0.
//
//   1. INTRO    "Hi <first name>": what this is, the privacy note, the language, Start
//   2. TALK     the assistant speaks (browser text-to-speech), then listens (browser
//               speech recognition) — tap the mic to interrupt; typing and the quick
//               answers always work too (iPhone / Firefox have no speech recognition)
//   3. DONE     thank you
// The candidate may answer in Telugu, Hindi or English: the server switches the
// assistant's language and this page follows (voice + recognition language).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import './talkLink.css';

const CODE = { English: 'en-IN', Telugu: 'te-IN', Hindi: 'hi-IN' };
const NATIVE = { English: 'English', Telugu: 'తెలుగు', Hindi: 'हिंदी' };
const QUICK = {
  English: ['Yes', 'No', 'Later'],
  Telugu: ['అవును', 'లేదు', 'తర్వాత'],
  Hindi: ['हाँ', 'नहीं', 'बाद में'],
};
const UI = {
  English: { listening: 'Listening… speak now', speaking: 'Assistant is speaking — tap the mic to answer', tap: 'Tap the mic to answer', type: 'Or type your answer', send: 'Send', thanks: 'Thank you! Your answers reached the TeamLink team.' },
  Telugu: { listening: 'వింటున్నాను… ఇప్పుడు మాట్లాడండి', speaking: 'అసిస్టెంట్ మాట్లాడుతోంది — జవాబు చెప్పడానికి మైక్ నొక్కండి', tap: 'జవాబు చెప్పడానికి మైక్ నొక్కండి', type: 'లేదా మీ జవాబు టైప్ చేయండి', send: 'పంపు', thanks: 'ధన్యవాదాలు! మీ జవాబులు టీమ్‌లింక్ టీమ్‌కు చేరాయి.' },
  Hindi: { listening: 'सुन रहा हूँ… अब बोलिए', speaking: 'असिस्टेंट बोल रहा है — जवाब देने के लिए माइक दबाएँ', tap: 'जवाब देने के लिए माइक दबाएँ', type: 'या अपना जवाब टाइप करें', send: 'भेजें', thanks: 'धन्यवाद! आपके जवाब टीमलिंक टीम तक पहुँच गए।' },
};
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

function pickVoice(lang) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  const code = CODE[lang] || 'en-IN';
  const two = code.slice(0, 2);
  return voices.find((v) => v.lang === code) || voices.find((v) => (v.lang || '').toLowerCase().startsWith(two)) || null;
}

export default function TalkLink() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [phase, setPhase] = useState('intro'); // intro | talk | done
  const [lang, setLang] = useState('English');
  const [msgs, setMsgs] = useState([]);
  const [mode, setMode] = useState('idle'); // idle | speaking | listening | thinking
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [voices, setVoices] = useState(0); // bumps when the browser's voice list arrives (Chrome loads it late)
  const [startAt, setStartAt] = useState(null); // talk time: counts from Start, stops at the end
  const [endAt, setEndAt] = useState(null);
  const [, setTick] = useState(0);
  const recRef = useRef(null);
  const langRef = useRef('English');
  const doneRef = useRef(false);
  const startedRef = useRef(false);
  const endRef = useRef(null);
  const ui = UI[lang] || UI.English;

  useEffect(() => {
    api.get(`/talk/${token}`)
      .then((r) => { setInfo(r.data); setLang(r.data.language || 'English'); langRef.current = r.data.language || 'English'; if (r.data.done) setPhase('done'); })
      .catch((e) => setErr((e.response && e.response.data && e.response.data.error) || 'This link could not be opened.'));
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices(); // loads the voice list early (Chrome fills it asynchronously)
      window.speechSynthesis.onvoiceschanged = () => setVoices((n) => n + 1);
    }
  }, [token]);

  useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, interim]);
  useEffect(() => { // the talk timer ticks once a second while the conversation runs
    if (!startAt || endAt) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startAt, endAt]);
  useEffect(() => { if (phase === 'done' && startAt && !endAt) setEndAt(Date.now()); }, [phase, startAt, endAt]);
  const talked = startAt ? Math.max(0, Math.round(((endAt || Date.now()) - startAt) / 1000)) : 0;
  const clock = `${Math.floor(talked / 60)}:${String(talked % 60).padStart(2, '0')}`;

  // leaving the page in the middle: the server records what was said so far
  useEffect(() => {
    const leave = () => {
      if (!startedRef.current || doneRef.current) return;
      try { navigator.sendBeacon(`/api/talk/${token}/turn`, new Blob([JSON.stringify({ event: 'stop' })], { type: 'application/json' })); } catch { /* best effort */ }
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [token]);

  const stopListening = () => { try { if (recRef.current) recRef.current.abort(); } catch { /* already stopped */ } recRef.current = null; };

  const listen = useCallback(() => {
    if (doneRef.current || !SR) { setMode('idle'); return; }
    stopListening();
    const rec = new SR();
    rec.lang = CODE[langRef.current] || 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let heard = '';
    rec.onresult = (ev) => {
      let fin = ''; let part = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        if (ev.results[i].isFinal) fin += ev.results[i][0].transcript; else part += ev.results[i][0].transcript;
      }
      if (fin) heard += fin;
      setInterim(heard || part);
    };
    rec.onerror = (ev) => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') setErr('The microphone is blocked. You can type your answers below.'); };
    rec.onend = () => {
      recRef.current = null;
      setInterim('');
      if (heard.trim()) send(heard.trim()); // eslint-disable-line no-use-before-define
      else setMode((m) => (m === 'listening' ? 'idle' : m));
    };
    recRef.current = rec;
    setMode('listening');
    try { rec.start(); } catch { setMode('idle'); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const speak = useCallback((text, then) => {
    const synth = window.speechSynthesis;
    if (!text || !synth) { if (then) then(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = CODE[langRef.current] || 'en-IN';
    const v = pickVoice(langRef.current);
    // no voice for this language: an English voice would read Telugu / Hindi letters as noise - show the text and listen instead
    if (!v && langRef.current !== 'English') { if (then) then(); return; }
    if (v) u.voice = v;
    u.rate = 1.0;
    u.onend = () => { if (then) then(); };
    u.onerror = () => { if (then) then(); };
    setMode('speaking');
    synth.speak(u);
  }, []);

  const handle = useCallback((data) => {
    if (data.language && data.language !== langRef.current) { langRef.current = data.language; setLang(data.language); }
    if (data.say) setMsgs((m) => [...m, { who: 'ai', text: data.say }]);
    if (data.done) {
      doneRef.current = true;
      speak(data.say, () => { setMode('idle'); setPhase('done'); });
      if (!data.say) setPhase('done');
      return;
    }
    speak(data.say, () => listen());
  }, [speak, listen]);

  const send = useCallback(async (text) => {
    const t = String(text || '').trim();
    if (!t || doneRef.current) return;
    stopListening();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setMsgs((m) => [...m, { who: 'me', text: t }]);
    setTyped('');
    setMode('thinking');
    try {
      const r = await api.post(`/talk/${token}/turn`, { text: t });
      handle(r.data);
    } catch (e) {
      setMode('idle');
      setErr((e.response && e.response.data && e.response.data.error) || 'Could not reach TeamLink. Please check your internet and try again.');
    }
  }, [token, handle]);

  async function start() {
    setErr('');
    langRef.current = lang;
    setPhase('talk');
    setMode('thinking');
    startedRef.current = true;
    setStartAt(Date.now());
    try {
      // the conversation AND the microphone start in the language the person chose (the browser listens in one language)
      const r = await api.post(`/talk/${token}/turn`, { event: 'start', language: lang });
      handle(r.data);
    } catch (e) {
      setMode('idle');
      setErr((e.response && e.response.data && e.response.data.error) || 'Could not start. Please try again.');
    }
  }

  // a language button: before Start it only picks the language; during the talk it switches the assistant and the microphone
  async function chooseLang(l) {
    if (phase === 'intro') { setLang(l); langRef.current = l; return; }
    if (doneRef.current || l === langRef.current) return;
    stopListening();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    langRef.current = l; setLang(l);
    setMode('thinking');
    try {
      const r = await api.post(`/talk/${token}/turn`, { event: 'language', language: l });
      handle(r.data);
    } catch (e) {
      setMode('idle');
      setErr((e.response && e.response.data && e.response.data.error) || 'Could not change the language. Please try again.');
    }
  }
  const noVoice = typeof window !== 'undefined' && window.speechSynthesis && voices >= 0 && !pickVoice(lang);

  function micTap() {
    if (mode === 'listening') { try { if (recRef.current) recRef.current.stop(); } catch { /* stopped */ } return; }
    if (window.speechSynthesis) window.speechSynthesis.cancel(); // the person interrupts: the assistant stops talking at once
    listen();
  }

  if (err && !info) {
    return <div className="tk-page"><div className="tk-card"><div className="tk-brand">TeamLink</div><p className="tk-error">{err}</p></div></div>;
  }
  if (!info) return <div className="tk-page"><div className="tk-card"><div className="tk-brand">TeamLink</div><p className="tk-muted">Loading…</p></div></div>;

  return (
    <div className="tk-page">
      <div className="tk-card">
        <div className="tk-head">
          <div className="tk-brand">TeamLink <span>AI assistant</span>{startAt && <span className="tk-clock" title="Talk time">⏱ {clock}</span>}</div>
          <div className="tk-langs" role="group" aria-label="Language">
            {(info.languages || ['English', 'Telugu', 'Hindi']).map((l) => (
              <button key={l} type="button" className={`tk-lang${l === lang ? ' on' : ''}`} disabled={phase === 'done' || (phase === 'talk' && mode === 'thinking')}
                onClick={() => chooseLang(l)}>
                {NATIVE[l]}
              </button>
            ))}
          </div>
        </div>

        {phase === 'intro' && (
          <div className="tk-intro">
            <h1>Hi {info.firstName || 'there'} 👋</h1>
            <p>This is <b>TeamLink Consultants&apos; AI recruitment assistant</b>. It takes about <b>2 minutes</b>.</p>
            <p>Speak in <b>Telugu, Hindi or English</b> — the assistant follows your language. You can also type.</p>
            <ul className="tk-notes">
              <li>TeamLink <b>never asks for money</b>, OTP or bank details.</li>
              <li>Your voice is turned into text by your browser&apos;s speech service (in Chrome, Google). Only the text reaches TeamLink.</li>
              {!SR && <li>Voice answers don&apos;t work in this browser — please type, or open the link in Chrome.</li>}
            </ul>
            <div className="tk-pick">
              <div className="tk-pick-q">Which language will you speak? · ఏ భాషలో మాట్లాడతారు? · आप किस भाषा में बोलेंगे?</div>
              <div className="tk-pick-row">
                {(info.languages || ['English', 'Telugu', 'Hindi']).map((l) => (
                  <button key={l} type="button" className={`tk-pick-btn${l === lang ? ' on' : ''}`} onClick={() => chooseLang(l)}>{NATIVE[l]}</button>
                ))}
              </div>
              <div className="tk-muted tk-small">You can change it any time with the buttons at the top.</div>
            </div>
            <p className="tk-agree">By pressing <b>Start</b> you agree to talk to TeamLink&apos;s AI assistant about your job application. Your answers are saved with your application. You can stop at any time — just close this page, or say &quot;stop&quot;.</p>
            <button type="button" className="tk-start" onClick={start}>▶ Start</button>
          </div>
        )}

        {phase !== 'intro' && (
          <>
            <div className="tk-chat">
              {msgs.map((m, i) => <div key={i} className={`tk-msg ${m.who}`}>{m.text}</div>)}
              {interim && <div className="tk-msg me interim">{interim}</div>}
              <div ref={endRef} />
            </div>
            {err && <p className="tk-error">{err}</p>}
            {phase === 'done' ? (
              <div className="tk-done">✅ {ui.thanks}{startAt && <div className="tk-small">⏱ {clock}</div>}</div>
            ) : (
              <div className="tk-controls">
                <div className="tk-status">{mode === 'listening' ? ui.listening : mode === 'speaking' ? ui.speaking : mode === 'thinking' ? '…' : SR ? ui.tap : ui.type}</div>
                {noVoice && <div className="tk-novoice">This browser has no {NATIVE[lang]} voice, so please read the assistant&apos;s words on the screen. You can still speak or type your answer. (Android phones have the voice.)</div>}
                {SR && (
                  <button type="button" className={`tk-mic${mode === 'listening' ? ' live' : ''}`} onClick={micTap} disabled={mode === 'thinking'} aria-label="Microphone">🎤</button>
                )}
                <div className="tk-quick">
                  {(QUICK[lang] || QUICK.English).map((q) => <button key={q} type="button" onClick={() => send(q)} disabled={mode === 'thinking'}>{q}</button>)}
                </div>
                <form className="tk-type" onSubmit={(e) => { e.preventDefault(); send(typed); }}>
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={ui.type} maxLength={300} />
                  <button type="submit" disabled={!typed.trim() || mode === 'thinking'}>{ui.send}</button>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

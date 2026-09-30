import { useCallback, useEffect, useRef, useState } from 'react';
import './AiVoice.css';

// ---------------------------------------------------------------------------
// VOICE INPUT for the AI Assistant / Agent — the browser's own Web Speech API
// (SpeechRecognition / webkitSpeechRecognition). No library, nothing
// downloaded. Chrome and Edge support it; Firefox and most others do not.
//
//   tap 🎤  → listening; the live transcript is written into the input box
//   silence → stops by itself (SILENCE_MS after the last word)
//   tap ■   → stops now
//   stop    → onDone({ text, confidence, lang }) — the panel auto-sends it
//             after a 1.5 s "Undo" window
//
// PRIVACY: the browser's recognizer may send the audio to the browser
// vendor's speech service (Google for Chrome, Microsoft for Edge). The panel
// says so in one line under the input.
//
// The constructor is looked up at CALL time (not import time), so a test can
// install a fake window.SpeechRecognition after the page has loaded.
// ---------------------------------------------------------------------------

export const VOICE_LANGS = [
  { code: 'en-IN', short: 'EN', label: 'English (India)' },
  { code: 'te-IN', short: 'తె', label: 'Telugu' },
  { code: 'hi-IN', short: 'हि', label: 'Hindi' },
];

const SILENCE_MS = 1800; // stop this long after the last recognised word
const NOTHING_HEARD_MS = 8000; // give up if nothing at all is heard

export function recognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

export function speak(text, lang) {
  if (!canSpeak) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text || ''));
    if (lang) u.lang = lang;
    window.speechSynthesis.speak(u);
  } catch { /* speech output is a nicety */ }
}

export function stopSpeaking() {
  try { if (canSpeak) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

// Per-viewer preferences. Storage can throw (private mode) — then defaults.
export function readPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; }
}
export function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// The browser's error codes, in words a user can act on.
export function voiceErrorText(code) {
  switch (code) {
    case 'unsupported':
      return 'Voice not supported in this browser — use Chrome or Edge.';
    case 'insecure':
      return 'Voice needs a secure (https) page. Open TeamLink over https to use the mic.';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Mic permission denied. Click the lock icon in the address bar → Site settings → Microphone → Allow, then tap 🎤 again.';
    case 'audio-capture':
      return 'No microphone found. Plug one in (or check it is not used by another app) and tap 🎤 again.';
    case 'no-speech':
      return 'I did not hear anything. Tap 🎤 and speak again.';
    case 'network':
      return 'The browser could not reach its speech service. Check the internet connection, or type instead.';
    case 'language-not-supported':
      return 'This browser cannot recognise that language. Pick another language or type instead.';
    default:
      return 'Voice input stopped unexpectedly. Tap 🎤 to try again, or type instead.';
  }
}

// useVoiceInput — one recognizer at a time.
//   onInterim(text)  live transcript while speaking
//   onDone({ text, confidence, lang })  after it stops with something heard
export function useVoiceInput({ onInterim, onDone }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const rec = useRef(null);
  const timers = useRef({});
  const cb = useRef({ onInterim, onDone });
  cb.current = { onInterim, onDone };

  const clearTimers = () => {
    clearTimeout(timers.current.silence);
    clearTimeout(timers.current.nothing);
  };

  const stop = useCallback(() => {
    clearTimers();
    if (rec.current) {
      try { rec.current.stop(); } catch { /* already stopped */ }
    }
  }, []);

  const start = useCallback((lang) => {
    setError(null);
    const Ctor = recognitionCtor();
    if (!Ctor) { setError('unsupported'); return false; }
    if (typeof window !== 'undefined' && window.isSecureContext === false) { setError('insecure'); return false; }
    if (rec.current) stop();
    let r;
    try { r = new Ctor(); } catch { setError('unsupported'); return false; }
    let finalText = '';
    let interimText = '';
    const confidences = [];
    let failed = false;
    let heardAnything = false;
    r.lang = lang || 'en-IN';
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      heardAnything = true;
      interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        const alt = res[0] || {};
        if (res.isFinal) {
          finalText = `${finalText} ${alt.transcript || ''}`.trim();
          if (typeof alt.confidence === 'number' && alt.confidence > 0) confidences.push(alt.confidence);
        } else {
          interimText = `${interimText} ${alt.transcript || ''}`.trim();
        }
      }
      if (cb.current.onInterim) cb.current.onInterim(`${finalText} ${interimText}`.trim());
      clearTimeout(timers.current.nothing);
      clearTimeout(timers.current.silence);
      timers.current.silence = setTimeout(() => { try { r.stop(); } catch { /* ignore */ } }, SILENCE_MS);
    };
    r.onerror = (e) => {
      const code = (e && e.error) || 'unknown';
      if (code === 'aborted') return;
      failed = code !== 'no-speech' || !heardAnything;
      if (failed) setError(code);
    };
    r.onend = () => {
      clearTimers();
      setListening(false);
      if (rec.current === r) rec.current = null;
      const text = `${finalText} ${interimText}`.trim();
      if (!text) {
        if (!failed) setError('no-speech');
        return;
      }
      // The worst segment decides: one badly heard phrase is enough to ask.
      const confidence = confidences.length ? Math.min(...confidences) : null;
      if (cb.current.onDone) cb.current.onDone({ text, confidence, lang: r.lang });
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
      setError('unknown');
      return false;
    }
    setListening(true);
    timers.current.nothing = setTimeout(() => { if (!heardAnything) { try { r.stop(); } catch { /* ignore */ } } }, NOTHING_HEARD_MS);
    return true;
  }, [stop]);

  // Never leave the mic open when the panel goes away.
  useEffect(() => () => {
    clearTimers();
    if (rec.current) {
      try { rec.current.abort ? rec.current.abort() : rec.current.stop(); } catch { /* ignore */ }
      rec.current = null;
    }
  }, []);

  return {
    listening, error, start, stop, clearError: () => setError(null),
  };
}

// The 🎤 button that sits in the input row.
export function MicButton({
  listening, disabled, onClick, lang,
}) {
  const label = listening ? 'Stop listening' : `Speak (${lang})`;
  return (
    <button
      className={`btn btn-ghost btn-sm ai-mic${listening ? ' ai-mic-on' : ''}`}
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={listening}
      disabled={disabled}
      data-testid="ai-mic"
    >
      {listening ? '■' : '🎤'}
    </button>
  );
}

// The line under the input: language, read-aloud toggle, state and the
// one-line privacy notice.
export function VoiceBar({
  lang, onLang, listening, error, pending, onUndo, tts, onTts, onDismissError,
}) {
  return (
    <div className="ai-voice" data-testid="ai-voice-bar">
      <div className="ai-voice-row">
        <label className="ai-voice-lang" title="Language you will speak in">
          <span className="sr-only">Voice language</span>
          <select value={lang} onChange={(e) => onLang(e.target.value)} aria-label="Voice language" data-testid="ai-voice-lang">
            {VOICE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.short} · {l.label}</option>)}
          </select>
        </label>
        {canSpeak && (
          <button
            type="button"
            className={`ai-voice-tts${tts ? ' on' : ''}`}
            onClick={() => onTts(!tts)}
            aria-pressed={tts}
            title={tts ? 'Reading answers aloud — click to stop' : 'Read answers aloud'}
          >
            {tts ? '🔊 Read aloud: on' : '🔈 Read aloud: off'}
          </button>
        )}
      </div>
      {listening && (
        <div className="ai-voice-state ai-voice-listening" role="status" aria-live="polite" data-testid="ai-voice-listening">
          <span className="ai-voice-dot" aria-hidden="true" /> Listening… speak now. It stops by itself when you pause, or tap ■.
        </div>
      )}
      {pending && (
        <div className="ai-voice-state ai-voice-pending" role="status" aria-live="polite" data-testid="ai-voice-pending">
          <span>Sending what I heard in 1.5 s…</span>
          <button type="button" className="link-btn" onClick={onUndo} data-testid="ai-voice-undo">Undo — let me edit</button>
        </div>
      )}
      {error && !listening && (
        <div className="ai-voice-state ai-voice-error" role="alert" data-testid="ai-voice-error">
          <span>{voiceErrorText(error)}</span>
          <button type="button" className="link-btn" onClick={onDismissError} aria-label="Dismiss">✕</button>
        </div>
      )}
      <div className="ai-voice-privacy">
        Voice uses your browser&apos;s speech recognition, which may send the audio to the browser vendor&apos;s service (e.g. Google for Chrome).
      </div>
    </div>
  );
}

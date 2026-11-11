import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import ListPageHeader from '../../components/ui/ListPageHeader.jsx';
import './voiceKit.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION -> AI VOICE RECORDING (founder 2026-11-11: "One AI Caller = One Consistent Voice Identity across all 3 languages").
// One speaker reads about 25 minutes in English, Telugu and Hindi: one line at a time, recorded, checked, saved. A voice is later
// trained on these recordings for each language, so the AI sounds like the same person in every language. Nothing here changes
// the live AI calls. Backend: routes/voiceKit.js; the lines: calling/voiceKitSentences.js.
// ---------------------------------------------------------------------------
const RATE = 22050;
const LANGS = ['English', 'Telugu', 'Hindi'];
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } } };

// Float32 at the microphone's rate -> 22050 Hz, the quiet at both ends cut to a quarter second
async function toTake(chunks, inRate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(len); let o = 0;
  chunks.forEach((c) => { all.set(c, o); o += c.length; });
  const outLen = Math.max(1, Math.round((len * RATE) / inRate));
  const off = new OfflineAudioContext(1, outLen, RATE);
  const buf = off.createBuffer(1, len, inRate); buf.copyToChannel(all, 0);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  let pcm = (await off.startRendering()).getChannelData(0);
  // trim: the first / last sound louder than the room, kept with 250 ms around it
  // The room's own level is read from the QUIETEST moments of the whole take (the 10th percentile of 20 ms windows), not from its
  // first 0.3 s: a speaker who starts reading the moment Record is pressed made that "room level" their own voice, and almost the
  // whole line was cut away ("Very short - was the whole line read?", 2026-11-11).
  const win = Math.round(RATE * 0.02);
  const peaks = [];
  for (let i = 0; i < pcm.length; i += win) { let m = 0; for (let j = i; j < Math.min(pcm.length, i + win); j += 1) m = Math.max(m, Math.abs(pcm[j])); peaks.push(m); }
  const sorted = peaks.slice().sort((x, y) => x - y);
  const floor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
  const level = Math.max(0.015, floor * 3);
  let a = 0; let b = pcm.length;
  for (let i = 0; i < pcm.length; i += win) { let m = 0; for (let j = i; j < Math.min(pcm.length, i + win); j += 1) m = Math.max(m, Math.abs(pcm[j])); if (m > level) { a = i; break; } }
  for (let i = pcm.length - win; i > 0; i -= win) { let m = 0; for (let j = i; j < Math.min(pcm.length, i + win); j += 1) m = Math.max(m, Math.abs(pcm[j])); if (m > level) { b = i + win; break; } }
  const pad = Math.round(RATE * 0.25);
  pcm = pcm.subarray(Math.max(0, a - pad), Math.min(pcm.length, b + pad));
  let peak = 0; let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; sum += v * v; }
  const rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
  // 16-bit WAV
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (p, s) => { for (let i = 0; i < s.length; i += 1) out.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return { blob: new Blob([out.buffer], { type: 'audio/wav' }), ms: Math.round((pcm.length / RATE) * 1000), peak, rms, floor };
}
// what is wrong with a take, in plain words (empty = good)
function checkTake(t) {
  if (!t) return [];
  const out = [];
  if (t.ms < 700) out.push('Very short - was the whole line read?');
  if (t.peak >= 0.99) out.push('Too loud: the sound is clipped. Move a little away from the microphone.');
  else if (t.rms < 0.015) out.push('Too quiet. Come a little closer or speak up a bit.');
  if (t.floor > 0.06) out.push('The room is noisy (fan, AC or traffic). A quieter room gives a cleaner voice.');
  return out;
}

export default function VoiceKit() {
  const [lang, setLang] = useState(() => (LANGS.includes(store.get('vk.lang', '')) ? store.get('vk.lang', '') : 'English'));
  const [gender, setGender] = useState(() => (store.get('vk.gender', 'female') === 'male' ? 'male' : 'female'));
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(null);
  const [i, setI] = useState(0);
  const [onlyTodo, setOnlyTodo] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [rec, setRec] = useState(false);
  const [take, setTake] = useState(null); // the new, not yet saved take
  const [level, setLevel] = useState(0);
  const [saving, setSaving] = useState(false);
  const mic = useRef(null); // { stream, ctx, node, chunks }
  const audio = useRef(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [l, p] = await Promise.all([api.get('/voice-kit/lines', { params: { lang, gender } }), api.get('/voice-kit/progress')]);
      setData(l.data); setProgress(p.data);
      return l.data;
    } catch (e) { setErr(errOf(e, 'Could not load the lines.')); return null; }
  }, [lang, gender]);
  useEffect(() => { store.set('vk.lang', lang); store.set('vk.gender', gender); setTake(null); load().then((d) => { if (d) { const first = d.lines.findIndex((x) => !x.take); setI(first >= 0 ? first : 0); } }); }, [lang, gender, load]);

  const lines = (data && data.lines) || [];
  const line = lines[i] || null;
  const mine = progress && progress.progress.find((p) => p.lang === lang && p.gender === gender);

  async function start() {
    setErr(''); setMsg(''); setTake(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const srcN = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      node.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0); chunks.push(new Float32Array(d));
        let m = 0; for (let k = 0; k < d.length; k += 64) m = Math.max(m, Math.abs(d[k])); setLevel(m);
      };
      srcN.connect(node); node.connect(ctx.destination);
      mic.current = { stream, ctx, node, chunks };
      setRec(true);
    } catch (e) { setErr('The microphone could not be opened. Allow the microphone for this site in the browser, then try again.'); }
  }
  async function stop() {
    const m = mic.current; mic.current = null; setRec(false); setLevel(0);
    if (!m) return;
    try { m.node.disconnect(); m.stream.getTracks().forEach((t) => t.stop()); } catch { /* closed */ }
    const rate = m.ctx.sampleRate; await m.ctx.close().catch(() => {});
    if (!m.chunks.length) return;
    const t = await toTake(m.chunks, rate);
    setTake(t);
    play(t.blob);
  }
  function play(blob) {
    if (audio.current) { audio.current.pause(); URL.revokeObjectURL(audio.current.src); }
    const a = new Audio(URL.createObjectURL(blob)); audio.current = a; a.play().catch(() => {});
  }
  async function playSaved() {
    if (!line) return;
    try { const r = await api.get('/voice-kit/take', { params: { lang, gender, id: line.id }, responseType: 'blob' }); play(r.data); } catch (e) { setErr('Could not play the saved recording.'); }
  }
  const next = useCallback((d = data) => {
    const all = (d && d.lines) || [];
    for (let k = i + 1; k < all.length; k += 1) if (!onlyTodo || !all[k].take) return setI(k);
    return setI(Math.min(all.length - 1, i + 1));
  }, [data, i, onlyTodo]);
  async function save() {
    if (!take || !line) return;
    setSaving(true); setErr('');
    try {
      await api.put('/voice-kit/take', take.blob, { params: { lang, gender, id: line.id }, headers: { 'Content-Type': 'audio/wav' } });
      setTake(null); setMsg(`Saved line ${line.n}.`);
      const d = await load(); next(d);
    } catch (e) { setErr(errOf(e, 'Could not save the recording.')); } finally { setSaving(false); }
  }
  async function remove() {
    if (!line || !line.take) return;
    if (!window.confirm('Delete the saved recording of this line?')) return;
    try { await api.delete('/voice-kit/take', { params: { lang, gender, id: line.id } }); await load(); } catch (e) { setErr(errOf(e, 'Could not delete it.')); }
  }
  async function exportZip() {
    setErr(''); setMsg('Preparing the download…');
    try {
      const r = await api.get('/voice-kit/export', { params: { lang, gender }, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `teamlink-voice-${lang.toLowerCase()}-${gender}.zip`; a.click();
      setMsg('Downloaded.');
    } catch (e) { setMsg(''); setErr('Nothing recorded yet in this language, or the download failed.'); }
  }

  // keyboard: R / Space = record or stop, Enter = save and next, P = play, arrows = previous / next
  useEffect(() => {
    const k = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === ' ' || e.key === 'r' || e.key === 'R') { e.preventDefault(); if (rec) stop(); else start(); }
      else if (e.key === 'Enter' && take && !saving) { e.preventDefault(); save(); }
      else if (e.key === 'p' || e.key === 'P') { if (take) play(take.blob); else playSaved(); }
      else if (e.key === 'ArrowRight') { setTake(null); setI((x) => Math.min(lines.length - 1, x + 1)); }
      else if (e.key === 'ArrowLeft') { setTake(null); setI((x) => Math.max(0, x - 1)); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = checkTake(take);
  const shown = useMemo(() => lines.map((l, k) => ({ ...l, k })).filter((l) => !onlyTodo || !l.take || l.k === i), [lines, onlyTodo, i]);

  return (
    <div className="vk">
      <ListPageHeader title="AI Voice Recording" question="One person reads these lines in English, Telugu and Hindi, about 25 minutes each. A voice is then trained on the recordings, so the AI calls sound like the same person in every language." />
      <div className="vk-rules">
        <b>Before you start</b>
        <ul>
          <li>The <b>same person</b> records all three languages, with the <b>same microphone</b>, in a <b>quiet room</b> (fan and AC off), the same distance from the microphone every time (about a hand span).</li>
          <li>Speak the way you talk to a candidate on the phone: calm, friendly, natural. <b>Not like a news reader.</b> Read the English words in Telugu / Hindi lines the way people really say them.</li>
          <li>Press <b>Record</b> (or Space), read the line, press <b>Stop</b>. It plays back. Happy? <b>Save &amp; next</b> (or Enter). Not happy? Record again. A mistake, a cough or a laugh: just record that line again.</li>
          <li>Take a break every 15 minutes and drink water - the voice must sound the same at the end as at the start.</li>
        </ul>
      </div>

      <div className="vk-bar">
        <div className="vk-langs">
          {LANGS.map((l) => {
            const p = progress && progress.progress.find((x) => x.lang === l && x.gender === gender);
            const pct = p ? Math.min(100, Math.round((p.minutes / ((progress && progress.goalMinutes) || 25)) * 100)) : 0;
            return (
              <button key={l} type="button" className={`vk-lang${l === lang ? ' on' : ''}`} onClick={() => setLang(l)}>
                <b>{l}</b>
                <span className="vk-prog"><i style={{ width: `${pct}%` }} /></span>
                <span className="small-muted">{p ? `${p.minutes} of ${(progress && progress.goalMinutes) || 25} min · ${p.done}/${p.lines} lines` : '…'}</span>
              </button>
            );
          })}
        </div>
        <label className="vk-gender">The speaker is
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="female">a woman</option>
            <option value="male">a man</option>
          </select>
          <span className="small-muted">(Hindi lines change: कर रही हूँ / कर रहा हूँ)</span>
        </label>
      </div>

      {err && <div className="notice red">{err}</div>}
      {msg && !err && <div className="notice green">{msg}</div>}

      {line && (
        <div className="vk-card">
          <div className="vk-meta"><span>Line {line.n} of {lines.length}</span><span className="small-muted">{line.kind === 'call' ? 'from the AI calls' : 'everyday call talk'}</span>{line.take && <span className="vk-done">Recorded · {secs(line.take.ms)}</span>}</div>
          <div className={`vk-text lang-${lang.toLowerCase()}`}>{line.text}</div>
          <div className="vk-meter"><i style={{ width: `${Math.min(100, Math.round(level * 140))}%`, background: level > 0.95 ? '#d64545' : level > 0.6 ? '#e59a1a' : '#22a06b' }} /></div>
          <div className="vk-actions">
            {!rec
              ? <button type="button" className="btn btn-primary vk-rec" onClick={start}>● Record</button>
              : <button type="button" className="btn vk-stop" onClick={stop}>■ Stop</button>}
            {take && <button type="button" className="btn" onClick={() => play(take.blob)}>▶ Play again</button>}
            {take && <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save & next'}</button>}
            {!take && line.take && <button type="button" className="btn" onClick={playSaved}>▶ Play saved</button>}
            {!take && line.take && <button type="button" className="btn btn-ghost" onClick={remove}>Delete</button>}
            <span className="vk-nav">
              <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => { setTake(null); setI(i - 1); }}>← Previous</button>
              <button type="button" className="btn btn-sm" disabled={i >= lines.length - 1} onClick={() => { setTake(null); next(); }}>Skip →</button>
            </span>
          </div>
          {take && (problems.length
            ? <div className="notice amber">{problems.map((p) => <div key={p}>{p}</div>)}<div className="small-muted">You can still save it, but recording it again is better.</div></div>
            : <div className="small-muted">Sounds clean ({secs(take.ms)}). Save it, or record again.</div>)}
          <div className="small-muted vk-keys">Keys: Space = record / stop · Enter = save &amp; next · P = play · ← → = previous / next</div>
        </div>
      )}

      <div className="vk-list-head">
        <b>All lines</b>
        <label><input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} /> Only the ones not recorded yet</label>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn btn-sm" onClick={exportZip} disabled={!mine || !mine.done}>Download {lang} recordings for training (ZIP)</button>
        </span>
      </div>
      <div className="vk-list">
        {shown.map((l) => (
          <button key={l.id} type="button" className={`vk-row${l.k === i ? ' on' : ''}`} onClick={() => { setTake(null); setI(l.k); }}>
            <span className="vk-n">{l.n}</span>
            <span className={`vk-rowtext lang-${lang.toLowerCase()}`}>{l.text}</span>
            <span className="vk-st">{l.take ? `✓ ${secs(l.take.ms)}` : ''}</span>
          </button>
        ))}
        {data && !shown.length && <div className="small-muted" style={{ padding: 12 }}>Every line of {lang} is recorded. Download the ZIP for training.</div>}
      </div>
    </div>
  );
}

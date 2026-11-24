import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import './interviewTools.css';
import { KitMapY, NotetakerY } from '../atsY/InterviewAiY.jsx'; // ATS wave 2 Y (07.11): notes per scorecard question, the meeting notetaker

// ---------------------------------------------------------------------------
// INTERVIEW TOOLS (market wave 2026-11-21) - inside the interview's panel in Interview Calendar (server: routes/mktInterviews.js).
//   Scorecard    the job's kit for this round: rate each question, one line of evidence, the recommendation (07.09)
//   Briefing     one page for the interviewer: who the person is, the kit, the earlier rounds (07.10; less for the BDE team)
//   Recordings   a recording file / link, reviewers' comments at a minute, the transcript, AI notes, voice feedback (07.07 / 07.11 / 07.13)
//   Summary      every rating and note of the interview in one paragraph (07.12)
//   Scheduling   free times, who can stand in, the self-booking link, the .ics, my calendar feed and Google / Microsoft (07.05 / 07.03 / 07.01)
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'That did not work. Please try again.';
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
const mmss = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

const TABS = [
  { key: 'score', label: 'Scorecard', hint: 'Rate the kit questions for this round and give your recommendation.' },
  { key: 'brief', label: 'Briefing', hint: 'One page before the interview: the person, the questions, the earlier rounds.' },
  { key: 'rec', label: 'Recordings & notes', hint: 'Add the recording, comment on it, turn the transcript into notes, or record your feedback by voice.' },
  { key: 'sum', label: 'Feedback summary', hint: 'Every rating and note of this interview in one short paragraph.' },
  { key: 'when', label: 'Scheduling', hint: 'Free times, a stand-in interviewer, the candidate\'s own booking link and calendars.', more: true },
];

export default function InterviewTools({ applicationId, round }) {
  const [tab, setTab] = useState('score');
  const [open, setOpen] = useState(false);
  return (
    <div className="ivt card" data-testid="interview-tools">
      <button type="button" className="ivt-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <b>Interview tools</b> <span className="small-muted">scorecard, briefing, recordings, AI notes, scheduling</span> <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <TabStrip small label="Interview tools" tabs={TABS} value={tab} onChange={setTab} />
          {tab === 'score' && <Scorecard applicationId={applicationId} round={round} />}
          {tab === 'brief' && <Briefing applicationId={applicationId} />}
          {tab === 'rec' && <Recordings applicationId={applicationId} round={round} />}
          {tab === 'sum' && <Summary applicationId={applicationId} />}
          {tab === 'when' && <Scheduling applicationId={applicationId} />}
        </>
      )}
    </div>
  );
}

function Scorecard({ applicationId, round }) {
  const [d, setD] = useState(null); const [ans, setAns] = useState({}); const [rec, setRec] = useState(''); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const load = useCallback(() => api.get(`/ats/mkt/interviews/${applicationId}/scorecard`, { params: { round } }).then((r) => {
    setD(r.data);
    const m = r.data.mine;
    setAns(Object.fromEntries(((m && m.answers) || []).map((a) => [a.i, { rating: a.rating == null ? '' : String(a.rating), note: a.note || '' }])));
    setRec((m && m.recommendation) || '');
  }).catch((e) => setErr(errOf(e))), [applicationId, round]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <div className="error-text">{err}</div>;
  if (!d) return <div className="small-muted">Loading the kit…</div>;
  const set = (i, patch) => setAns((a) => ({ ...a, [i]: { ...(a[i] || {}), ...patch } }));
  async function save() {
    setErr(''); setMsg('');
    try {
      const answers = d.kit.questions.map((q, i) => ({ i, rating: q.type === 'yesno' ? (ans[i] && ans[i].rating) : (ans[i] && ans[i].rating !== '' ? Number(ans[i].rating) : null), note: ans[i] && ans[i].note }));
      const r = await api.put(`/ats/mkt/interviews/${applicationId}/scorecard`, { round: d.round, answers, recommendation: rec || null });
      setMsg(`Saved. Overall ${r.data.score.overall == null ? '-' : `${r.data.score.overall} of 5`}.`); load();
    } catch (e) { setErr(errOf(e)); }
  }
  return (
    <div className="ivt-body">
      <div className="small-muted">{d.kit.title} · {d.kit.saved ? 'the job\'s kit' : 'a ready kit from the job skills (the TL can change it on the requirement, Kits & tests tab)'} · scale 1-{d.kit.scale}</div>
      {d.kit.guide && <div className="ivt-guide">{d.kit.guide}</div>}
      <ol className="ivt-qs">
        {d.kit.questions.map((q, i) => (
          <li key={i}>
            <div><b>{q.text}</b>{q.competency && <span className="skillpill">{q.competency}</span>}</div>
            {q.guidance && <div className="small-muted">{q.guidance}</div>}
            <div className="ivt-row">
              {q.type === 'rating' && (
                <div className="ivt-scale" role="radiogroup" aria-label={`Rating for question ${i + 1}`}>
                  {Array.from({ length: d.kit.scale }, (_, n) => n + 1).map((n) => (
                    <button type="button" key={n} disabled={!d.canFill} className={`btn btn-sm${String(n) === (ans[i] && ans[i].rating) ? ' btn-primary' : ''}`} onClick={() => set(i, { rating: String(n) })}>{n}</button>
                  ))}
                </div>
              )}
              {q.type === 'yesno' && (
                <select value={(ans[i] && ans[i].rating) || ''} disabled={!d.canFill} onChange={(e) => set(i, { rating: e.target.value })}><option value="">-</option><option value="yes">Yes</option><option value="no">No</option></select>
              )}
              <input type="text" placeholder="Evidence / note" value={(ans[i] && ans[i].note) || ''} disabled={!d.canFill} onChange={(e) => set(i, { note: e.target.value })} />
            </div>
          </li>
        ))}
      </ol>
      <div className="ivt-row">
        <label className="small-muted" htmlFor={`ivt-rec-${applicationId}`}>Recommendation</label>
        <select id={`ivt-rec-${applicationId}`} value={rec} disabled={!d.canFill} onChange={(e) => setRec(e.target.value)}><option value="">-</option>{d.recs.map((x) => <option key={x}>{x}</option>)}</select>
        {d.canFill && <button type="button" className="btn btn-sm btn-primary" onClick={save}>Save my scorecard</button>}
      </div>
      {!d.canFill && <div className="small-muted">Your role reads the scorecard but does not fill it.</div>}
      {msg && <div className="notice">{msg}</div>}
      {err && <div className="error-text">{err}</div>}
      {d.others.length > 0 && (
        <div className="ivt-others"><div className="small-muted">Other interviewers this round</div>
          {d.others.map((o) => <div key={o.id} className="kv"><span className="k">{o.userName}</span><span>{o.overall == null ? '-' : `${o.overall}/5`} {o.recommendation || ''}</span></div>)}
        </div>
      )}
    </div>
  );
}

function Briefing({ applicationId }) {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { api.get(`/ats/mkt/interviews/${applicationId}/briefing`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))); }, [applicationId]);
  if (err) return <div className="error-text">{err}</div>;
  if (!d) return <div className="small-muted">Loading the briefing…</div>;
  const c = d.candidate;
  const kv = (k, v) => (v || v === 0 ? <div className="kv"><span className="k">{k}</span><span>{v}</span></div> : null);
  return (
    <div className="ivt-body ivt-brief">
      {d.limitedNote && <div className="notice">{d.limitedNote}</div>}
      <div className="grid-2">
        <div>
          <h4>{c.name}</h4>
          {kv('Now', [c.currentDesignation, c.currentCompany].filter(Boolean).join(' at '))}
          {kv('Experience', c.experienceYears != null ? `${c.experienceYears} years` : null)}
          {kv('Location', c.location)}
          {kv('Notice', c.noticePeriod)}
          {kv('Education', c.education)}
          {kv('Current / expected', c.currentSalary || c.expectedSalary ? `${c.currentSalary || '-'} / ${c.expectedSalary || '-'}` : null)}
          {kv('Resume', c.resume ? c.resume.fileName : 'none on file')}
          {c.skills && <div>{String(c.skills).split(',').map((s) => <span className="skillpill" key={s}>{s.trim()}</span>)}</div>}
        </div>
        <div>
          <h4>{d.job.title}</h4>
          {kv('Client', d.job.client)}
          {kv('Experience asked', d.job.experience)}
          {kv('Round', `${d.interview.round} · ${when(d.interview.at)} · ${d.interview.mode || ''}`)}
          {kv('Interviewer', d.interview.interviewer)}
          {d.interview.link && <div className="kv"><span className="k">Link</span><a href={d.interview.link} target="_blank" rel="noreferrer">open</a></div>}
        </div>
      </div>
      <h4>Questions to ask ({d.kit.title})</h4>
      <ol>{d.kit.questions.map((q, i) => <li key={i}>{q.text}{q.guidance && <span className="small-muted"> - {q.guidance}</span>}</li>)}</ol>
      {(d.pastRounds.length > 0 || d.pastScores.length > 0) && <h4>Earlier rounds</h4>}
      {d.pastRounds.map((p) => <div key={`r${p.round}`} className="kv"><span className="k">Round {p.round} {p.roundType || ''}</span><span>{p.recommendation || '-'} {p.average ? `· ${p.average}/5` : ''} {p.comments ? `· ${p.comments}` : ''}</span></div>)}
      {d.pastScores.map((p, i) => <div key={`s${i}`} className="kv"><span className="k">Round {p.round} · {p.by}</span><span>{p.overall == null ? '-' : `${p.overall}/5`} {p.recommendation || ''} {p.summary ? `· ${p.summary}` : ''}</span></div>)}
      <button type="button" className="btn btn-sm" onClick={() => window.print()}>Print</button>
    </div>
  );
}

function VoiceFeedback({ applicationId, round, onDone }) {
  const [state, setState] = useState('idle'); const [words, setWords] = useState(''); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const recRef = useRef(null); const chunks = useRef([]); const speech = useRef(null);
  const canRecord = typeof window !== 'undefined' && window.MediaRecorder && navigator.mediaDevices;
  async function start() {
    setErr(''); setMsg(''); chunks.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.current.push(e.data); };
      mr.onstop = () => stream.getTracks().forEach((t) => t.stop());
      mr.start(); recRef.current = mr; setState('rec');
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR) { const s = new SR(); s.lang = 'en-IN'; s.continuous = true; s.interimResults = false; s.onresult = (ev) => { let t = ''; for (let i = 0; i < ev.results.length; i += 1) t += `${ev.results[i][0].transcript} `; setWords(t.trim()); }; try { s.start(); speech.current = s; } catch { /* no speech words */ } }
    } catch { setErr('The microphone could not be opened. Allow it in the browser, or type your feedback.'); }
  }
  function stopRec() { if (recRef.current) recRef.current.stop(); if (speech.current) try { speech.current.stop(); } catch { /* done */ } setState('done'); }
  async function send() {
    setErr('');
    try {
      const fd = new FormData();
      fd.append('round', String(round || 1)); fd.append('transcript', words);
      if (chunks.current.length) fd.append('file', new Blob(chunks.current, { type: 'audio/webm' }), 'voice.webm');
      const r = await api.post(`/ats/mkt/interviews/${applicationId}/voice-feedback`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setMsg(r.data.transcript ? 'Saved: your words are on your scorecard for this round.' : (r.data.source || 'Saved.')); setState('idle'); setWords(''); if (onDone) onDone();
    } catch (e) { setErr(errOf(e)); }
  }
  return (
    <div className="ivt-voice">
      <div className="small-muted">Voice feedback: speak for a minute after the interview. {canRecord ? 'The phone writes the words where it can; you can correct them.' : 'This browser cannot record; type your feedback below.'}</div>
      <div className="ivt-row">
        {canRecord && state !== 'rec' && <button type="button" className="btn btn-sm" onClick={start}>🎙 Record</button>}
        {state === 'rec' && <button type="button" className="btn btn-sm btn-danger" onClick={stopRec}>■ Stop</button>}
        {state === 'rec' && <span className="small-muted">Recording…</span>}
      </div>
      <textarea rows="3" placeholder="Your feedback in words (filled while you speak, or type it)" value={words} onChange={(e) => setWords(e.target.value)} />
      <button type="button" className="btn btn-sm btn-primary" disabled={!words.trim() && !chunks.current.length} onClick={send}>Save voice feedback</button>
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

function Recordings({ applicationId, round }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const [link, setLink] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/ats/mkt/interviews/${applicationId}/recordings`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), [applicationId]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <div className="error-text">{err}</div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.hidden) return <div className="small-muted">The BDE team does not open interview recordings.</div>;
  const run = async (fn) => { setErr(''); setMsg(''); setBusy(true); try { await fn(); } catch (e) { setErr(errOf(e)); } setBusy(false); };
  const upload = (file) => run(async () => { const fd = new FormData(); fd.append('file', file); fd.append('round', String(round || 1)); fd.append('title', file.name); const up = await api.post(`/ats/mkt/interviews/${applicationId}/recordings`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }); await load(); const a = up.data && up.data.auto; setMsg(a && a.transcribed ? `Recording added, turned into text (${a.source})${a.notes ? ' and the notes are written' : ''}.` : `Recording added.${a && a.why ? ` ${a.why}` : ''}`); });
  const addLink = () => run(async () => { await api.post(`/ats/mkt/interviews/${applicationId}/recordings`, { url: link, round }); setLink(''); await load(); });
  return (
    <div className="ivt-body">
      {d.canAdd && (
        <div className="ivt-row">
          <label className="btn btn-sm">Upload recording<input type="file" accept="audio/*,video/mp4,video/webm" hidden onChange={(e) => e.target.files[0] && upload(e.target.files[0])} /></label>
          <input type="url" placeholder="or paste the Meet / Zoom / Drive link" value={link} onChange={(e) => setLink(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!link || busy} onClick={addLink}>Add link</button>
        </div>
      )}
      <div className="small-muted">Up to {d.maxMb} MB. {d.speech ? `An uploaded file is turned into text and its notes written at once (${d.speechEngine || 'speech to text'}).` : (d.speechWhy || 'No speech to text is set up: paste the transcript (Meet / Zoom / Teams give one).')}</div>
      {d.rows.length === 0 && <div className="small-muted">No recordings yet.</div>}
      {d.rows.map((r) => <RecordingRow key={r.id} r={r} onChanged={load} speech={d.speech} />)}
      {d.canAdd && <VoiceFeedback applicationId={applicationId} round={round} onDone={load} />}
      {d.canAdd && <NotetakerY applicationId={applicationId} round={round} onDone={load} />}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

function RecordingRow({ r, onChanged, speech }) {
  const [comment, setComment] = useState(''); const [at, setAt] = useState(''); const [tr, setTr] = useState(''); const [showTr, setShowTr] = useState(false); const [err, setErr] = useState(''); const [src, setSrc] = useState('');
  const run = async (fn) => { setErr(''); try { await fn(); onChanged(); } catch (e) { setErr(errOf(e)); } };
  async function play() {
    try { const b = await api.get(`/ats/mkt/recordings/${r.id}/file`, { responseType: 'blob' }); setSrc(URL.createObjectURL(b.data)); } catch (e) { setErr(errOf(e)); }
  }
  return (
    <div className="ivt-recrow">
      <div className="ivt-row"><b>{r.title || r.kind}</b><span className="small-muted">round {r.round} · {r.createdBy} · {when(r.createdAt)}</span>
        {r.url && <a href={r.url} target="_blank" rel="noreferrer">open link</a>}
        {r.hasFile && !src && <button type="button" className="btn btn-sm btn-ghost" onClick={play}>▶ Play</button>}
      </div>
      {src && (/video/.test(r.fileMime || '') ? <video src={src} controls style={{ maxWidth: '100%' }} /> : <audio src={src} controls />)}
      {r.reviews.map((v) => <div key={v.id} className="small-muted">{v.atSec != null ? `[${mmss(v.atSec)}] ` : ''}<b>{v.userName}</b>: {v.comment}{v.rating ? ` (${v.rating}/5)` : ''}</div>)}
      <div className="ivt-row">
        <input type="text" placeholder="mm:ss" style={{ width: 70 }} value={at} onChange={(e) => setAt(e.target.value)} aria-label="Time in the recording" />
        <input type="text" placeholder="Your comment on this recording" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={!comment.trim()} onClick={() => run(async () => { await api.post(`/ats/mkt/recordings/${r.id}/reviews`, { comment, at: at || undefined }); setComment(''); setAt(''); })}>Comment</button>
      </div>
      <div className="ivt-row">
        {r.transcript ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowTr((s) => !s)}>{showTr ? 'Hide' : 'Show'} transcript ({r.transcriptSource})</button>
          : <>
            {r.hasFile && speech && <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats/mkt/recordings/${r.id}/transcript`, {}))}>Turn into text</button>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowTr(true)}>Paste transcript</button>
          </>}
        {r.transcript && <button type="button" className="btn btn-sm btn-primary" onClick={() => run(() => api.post(`/ats/mkt/recordings/${r.id}/notes`, {}))}>{r.notes ? 'Make the notes again' : 'Make AI notes'}</button>}
      </div>
      {showTr && (r.transcript ? <pre className="ivt-tr">{r.transcript}</pre> : (
        <div><textarea rows="4" value={tr} onChange={(e) => setTr(e.target.value)} placeholder="Paste the transcript here" />
          <button type="button" className="btn btn-sm" disabled={!tr.trim()} onClick={() => run(async () => { await api.post(`/ats/mkt/recordings/${r.id}/transcript`, { text: tr }); setTr(''); })}>Save transcript</button></div>
      ))}
      {r.notes && (
        <div className="ivt-notes">
          <div className="small-muted">Notes · {r.notes.source}</div>
          <p>{r.notes.summary}</p>
          {[['Strengths', r.notes.strengths], ['Concerns', r.notes.concerns], ['Questions asked', r.notes.questionsAsked], ['Next steps', r.notes.nextSteps]].filter(([, l]) => l && l.length).map(([k, l]) => <div key={k}><b>{k}</b><ul>{l.map((x, i) => <li key={i}>{x}</li>)}</ul></div>)}
        </div>
      )}
      {r.notes && <KitMapY r={r} />}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function Summary({ applicationId }) {
  const [d, setD] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(() => { setD(null); api.get(`/ats/mkt/interviews/${applicationId}/feedback-summary`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))); }, [applicationId]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="error-text">{err}</div>;
  if (!d) return <div className="small-muted">Summing up…</div>;
  return (
    <div className="ivt-body">
      <p className="ivt-summary">{d.text}</p>
      {d.source && <div className="small-muted">{d.source}. A suggestion to read, never a decision.</div>}
      {(d.items || []).map((i, n) => <div key={n} className="kv"><span className="k">Round {i.round} · {i.who}</span><span>{i.rating == null ? '' : `${i.rating}/5 `}{i.rec || ''}</span></div>)}
      <button type="button" className="btn btn-sm" onClick={load}>Sum up again</button>
    </div>
  );
}

function Scheduling({ applicationId }) {
  const [slots, setSlots] = useState(null); const [reps, setReps] = useState(null); const [sb, setSb] = useState(null); const [made, setMade] = useState(null);
  const [feed, setFeed] = useState(null); const [cal, setCal] = useState(null); const [picked, setPicked] = useState([]); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [links, setLinks] = useState(null); // links: 14.05 (ATS wave 2 Z)
  const loadSb = useCallback(() => api.get(`/ats/mkt/interviews/${applicationId}/self-book`).then((r) => setSb(r.data)).catch(() => setSb(null)), [applicationId]);
  useEffect(() => { loadSb(); api.get('/ats/mkt/calendar/connections').then((r) => setCal(r.data)).catch(() => null); }, [loadSb]);
  const run = async (fn) => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(errOf(e)); } };
  const toggle = (s) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));
  async function ics() {
    await run(async () => {
      const r = await api.get(`/ats/mkt/interviews/${applicationId}/ics`, { responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'interview.ics'; a.click();
    });
  }
  return (
    <div className="ivt-body">
      <h4>Free times</h4>
      <div className="ivt-row">
        <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/interviews/${applicationId}/suggest-slots`, { days: 6 }); setSlots(r.data); setPicked(r.data.slots.slice(0, 3).map((s) => s.start)); })}>Suggest free times</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/interviews/${applicationId}/replacements`, {}); setReps(r.data); })}>Interviewer can't come? Find a stand-in</button>
      </div>
      {slots && <div className="small-muted">{slots.reason}</div>}
      {slots && slots.slots.map((s) => <label key={s.start} className="ivt-slot"><input type="checkbox" checked={picked.includes(s.start)} onChange={() => toggle(s.start)} /> {when(s.start)}</label>)}
      {reps && (reps.rows.length ? reps.rows.map((p) => <div key={p.id} className="kv"><span className="k">{p.name}</span><span className="small-muted">{p.why}</span></div>) : <div className="small-muted">Nobody else is free then.</div>)}
      {reps && reps.rows.length > 0 && <div className="small-muted">Change the panel with "Change panel" above.</div>}

      <h4>Let the candidate pick</h4>
      {sb && !sb.switchOn && <div className="small-muted">Self-scheduling is switched off (an Admin turns it on in Administration &gt; Step timing and alerts).</div>}
      {sb && sb.switchOn && !sb.jobOn && <div className="small-muted">Off for this job: tick it on the requirement, Kits &amp; tests tab.</div>}
      {sb && sb.switchOn && sb.jobOn && sb.canCreate && (
        <div className="ivt-row">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/interviews/${applicationId}/self-book`, { slots: picked }); setMade(r.data); loadSb(); })}>{picked.length ? `Make a link with ${picked.length} time(s)` : 'Make a link (free times found by TeamLink)'}</button>
          <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/interviews/${applicationId}/self-book`, { slots: picked, email: true }); setMade(r.data); loadSb(); })}>…and email it</button>
        </div>
      )}
      {made && <div className="notice">Link: <a href={made.link} target="_blank" rel="noreferrer">{made.link}</a>{made.sent ? ` · email ${made.sent}` : ''} <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard && navigator.clipboard.writeText(made.link)}>Copy</button></div>}
      {sb && sb.rows.map((x) => <div key={x.token} className="kv"><span className="k">{when(x.createdAt)} · {x.slots.length} times</span><span>{x.status === 'booked' ? `booked ${when(x.pickedSlot)}` : x.status === 'declined' ? 'none of the times worked - send new times' : x.status}</span></div>)}

      <h4>Calendars</h4>
      <div className="ivt-row">
        <button type="button" className="btn btn-sm" onClick={ics}>Download .ics</button>
        <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.get('/ats/mkt/calendar/feed'); setFeed(r.data); })}>My calendar feed</button>
        <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/interviews/${applicationId}/calendar-push`, {}); setMsg(r.data.message); })}>Put in my Google / Outlook calendar</button>
        {/* 14.05 (ATS wave 2 Z): add it by hand to any Google / Outlook calendar - no account connection needed */}
        <button type="button" className="btn btn-sm" data-testid="cal-links" onClick={() => run(async () => { const r = await api.get(`/ats-plus/integrations/calendar-links/${applicationId}`); setLinks(r.data); })}>Add to Google / Outlook</button>
      </div>
      {links && <div className="ivt-row"><a className="btn btn-sm" href={links.google} target="_blank" rel="noreferrer">Google Calendar</a><a className="btn btn-sm" href={links.outlook} target="_blank" rel="noreferrer">Outlook</a></div>}
      {feed && <div className="notice"><div>Add this address in Google Calendar (Other calendars &gt; From URL) or Outlook (Add calendar &gt; Subscribe from web):</div><code className="ivt-code">{feed.url}</code><div className="small-muted">{feed.note}</div><button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { const r = await api.post('/ats/mkt/calendar/feed/reset', {}); setFeed({ ...feed, url: r.data.url }); })}>Reset the address</button></div>}
      {cal && Object.entries(cal.rows).map(([p, c]) => (
        <div key={p} className="kv"><span className="k">{c.label}</span>
          <span>{c.connected ? <>connected{c.account ? ` (${c.account})` : ''} <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(async () => { const r = await api.delete(`/ats/mkt/calendar/${p}`); setCal({ ...cal, rows: r.data.rows }); })}>Disconnect</button></> : (c.appReady ? <button type="button" className="btn btn-sm" onClick={() => run(async () => { const r = await api.post(`/ats/mkt/calendar/${p}/connect`, {}); window.location.href = r.data.url; })}>Connect</button> : <span className="small-muted">needs the company's app keys (Admin)</span>)}{c.lastError ? <span className="error-text"> {c.lastError}</span> : null}</span>
        </div>
      ))}
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

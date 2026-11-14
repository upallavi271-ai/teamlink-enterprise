import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, Banner, Field, ConfirmModal } from '../ui.jsx';

const INR_PER_USD = 88; // only for the "about" rupee figure shown next to the dollar estimate
const usd = (n) => `US$${Number(n || 0).toFixed(2)}`;
const inr = (n) => `₹${Math.round(Number(n || 0) * INR_PER_USD)}`;

// "✦ Make a clip with AI": asks Google Veo for a real moving clip. It is paid by Google, so the cost is shown and must be confirmed.
export default function AiClipPanel({ pictures, toast, onMade }) {
  const [meta, setMeta] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [pictureId, setPictureId] = useState('');
  const [aspect, setAspect] = useState('9:16');
  const [seconds, setSeconds] = useState(6);
  const [job, setJob] = useState(null);
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const alive = useRef(true);

  const loadMeta = useCallback(() => omni.get('/gs/marketing/clip-ai/meta').then((d) => { if (!alive.current) return; setMeta(d); if (d.active) { setJob(d.active); setOpen(true); } }).catch((e) => alive.current && setErr(errOf(e, 'AI clips could not be checked.'))), []);
  useEffect(() => { alive.current = true; loadMeta(); return () => { alive.current = false; clearTimeout(timer.current); }; }, [loadMeta]);

  // follow a running job every few seconds
  useEffect(() => {
    clearTimeout(timer.current);
    if (!job || job.status !== 'running') return undefined;
    timer.current = setTimeout(() => {
      omni.get(`/gs/marketing/clip-ai/jobs/${job.id}`).then((d) => {
        if (!alive.current) return;
        setJob(d.job);
        if (d.job.status === 'done') { toast('Your AI clip is ready. Find it under Your clips, then ask for approval.'); loadMeta(); if (onMade) onMade(); }
        if (d.job.status === 'failed') loadMeta();
      }).catch(() => { if (alive.current) setJob((j) => (j ? { ...j } : j)); }); // a short network hiccup: just look again
    }, 4000);
    return () => clearTimeout(timer.current);
  }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta) return err ? <Banner tone="error">{err}</Banner> : null;
  const running = job && job.status === 'running';
  const cost = Math.round(meta.costPerSec * seconds * 100) / 100;
  const okPrompt = prompt.trim().length >= 10;
  const can = meta.ready && !running && okPrompt && meta.left > 0;

  const send = () => {
    setAsk(false); setErr('');
    omni.post('/gs/marketing/clip-ai', { prompt: prompt.trim(), pictureId: pictureId || undefined, aspect, seconds, confirm: true })
      .then((d) => { setJob(d.job); loadMeta(); })
      .catch((e) => { setErr(errOf(e, 'The clip could not be started.')); loadMeta(); });
  };

  return (
    <Panel title="✦ Make a clip with AI" sub="Describe a short scene and Google Veo makes a real moving clip, with sound. Paid by Google per second: you see the cost first." style={{ marginBottom: 14 }}
      right={<Btn onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Open'}</Btn>}>
      {!open && !running ? <div style={{ fontSize: 12, opacity: 0.75 }}>{meta.ready ? `Ready. ${meta.left} of ${meta.perDay} clips left today for you.` : meta.reason}</div> : null}
      {open || running ? (
        <div>
          {!meta.ready ? <Banner tone="warn">{meta.reason}</Banner> : null}
          {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
          <div className="gs-form" style={{ display: 'grid', gap: 10 }}>
            <Field label="WHAT SHOULD HAPPEN IN THE CLIP?" full>
              <textarea rows={3} maxLength={800} value={prompt} disabled={running || !meta.ready} onChange={(e) => setPrompt(e.target.value)} placeholder="A nurse walks through a bright hospital corridor and smiles at the camera" style={{ width: '100%' }} />
            </Field>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Field label="SIZE">
                <select value={aspect} disabled={running} onChange={(e) => setAspect(e.target.value)}>
                  <option value="9:16">Tall 9:16 (Reels, Status)</option>
                  <option value="16:9">Wide 16:9 (YouTube, LinkedIn)</option>
                </select>
              </Field>
              <Field label="LENGTH">
                <select value={seconds} disabled={running} onChange={(e) => setSeconds(Number(e.target.value))}>
                  {meta.seconds.map((s) => <option key={s} value={s}>{s} seconds</option>)}
                </select>
              </Field>
              <Field label="START FROM A PICTURE (OPTIONAL)">
                <select value={pictureId} disabled={running} onChange={(e) => setPictureId(e.target.value)}>
                  <option value="">None: only from the words</option>
                  {(pictures || []).map((p) => <option key={p.id} value={p.id}>{p.title || p.headline || p.id}</option>)}
                </select>
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <Btn primary disabled={!can} onClick={() => setAsk(true)}>✦ Make the clip</Btn>
            <span style={{ fontSize: 12 }}>Cost about <b>{usd(cost)}</b> (≈ {inr(cost)}), charged by Google. {meta.ready ? `${meta.left} of ${meta.perDay} clips left today.` : ''}</span>
          </div>
          {!okPrompt && !running && meta.ready ? <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>Write at least a short sentence about the scene.</div> : null}
          {job ? (
            <div style={{ marginTop: 12 }}>
              {job.status === 'running' ? <Banner tone="info">Making your clip… {job.seconds}s so far. It takes 1 to 5 minutes. You can leave this page: it keeps going, and the clip appears under Your clips.</Banner> : null}
              {job.status === 'done' ? <Banner tone="ok">Done. The clip is under <b>Your clips</b> below. Ask for approval, then use it in a video.</Banner> : null}
              {job.status === 'failed' ? <Banner tone="error">{job.error || 'The clip could not be made.'}</Banner> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {ask ? <ConfirmModal title="Pay Google for this clip?" yes={`Yes, make it (${usd(cost)})`} onNo={() => setAsk(false)} onYes={send}
        text={`This clip (${seconds} seconds) is billed by Google, about ${usd(cost)} (≈ ${inr(cost)}). It starts now and cannot be cancelled. The clip is saved as a draft: it needs approval like any other clip.`} /> : null}
    </Panel>
  );
}

import { useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { Panel, Btn, Banner, Field, Pill } from '../ui.jsx';

// "✦ CREATE FROM A PROMPT": a person types one sentence ("a Diwali offer video for our clients, 20% off, for 12 November"). The AI plans it (headline, scene texts, picture
// descriptions, caption, hashtags: marketing/autostudio.js), a picture is made for every scene with AI Images, and then either the pictures become a VIDEO (the AI Video
// page puts them together in the browser: onVideo) or they stay as picture POSTS (onMade). Everything lands as a DRAFT that still needs approval (team or client).
// kind 'video' | 'post'. projectId: made for a client project (its logo and colours are used). Nothing is posted from here.
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const PLATS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['linkedin', 'LinkedIn'], ['x', 'X'], ['whatsapp', 'WhatsApp status']];
const tomorrow = () => new Date(Date.now() + 86400000 + 19800000).toISOString().slice(0, 10);

export default function AutoStudioPanel({ kind = 'video', projectId = '', onVideo, onMade, toast }) {
  const isVideo = kind === 'video';
  const [prompt, setPrompt] = useState('');
  const [date, setDate] = useState('');
  const [scenes, setScenes] = useState(isVideo ? 4 : 2);
  const [aspect, setAspect] = useState(isVideo ? '9:16' : '1:1');
  const [phase, setPhase] = useState(''); // '' | 'plan' | 'pics' | 'done'
  const [step, setStep] = useState({ i: 0, n: 0 });
  const [plan, setPlan] = useState(null);
  const [flags, setFlags] = useState([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(true);
  const [plats, setPlats] = useState(['instagram', 'facebook']);
  const [when, setWhen] = useState({ date: '', time: '10:00' });
  const [busy, setBusy] = useState('');
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const working = phase === 'plan' || phase === 'pics';

  // one scene's picture: start the job, then ask every 3 seconds until it is done (the same way the AI Images page does). A "too many in a minute" answer waits and tries again.
  const makePicture = async (scene) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let r;
      try { r = await omni.post('/gs/marketing/images', { prompt: scene.imagePrompt, headline: '', style: 'photo', aspect, count: 1, useColors: true, withLogo: !isVideo, ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) }); } catch (e) {
        const st = e.response && e.response.status;
        if (st === 429 && /minute|wait/i.test(errOf(e, ''))) { await sleep(15000); if (stop.current) throw new Error('stopped'); continue; } // eslint-disable-line no-continue, no-await-in-loop
        throw e;
      }
      let job = r.job; const t0 = Date.now();
      while (job && job.status === 'running') {
        await sleep(3000); // eslint-disable-line no-await-in-loop
        if (stop.current) throw new Error('stopped');
        if (Date.now() - t0 > 4 * 60000) throw new Error('A picture is taking too long. Try again in a minute.');
        try { job = (await omni.get(`/gs/marketing/images/jobs/${job.id}`)).job; } catch (e) { if (e.response && e.response.status === 404) throw new Error('The picture job was lost. Try again.'); } // eslint-disable-line no-await-in-loop
      }
      if (!job || job.status === 'failed') throw new Error((job && job.error) || 'A picture could not be made.');
      return job.items[0].id;
    }
    throw new Error('Too many picture requests in a minute. Wait a moment and try again.');
  };

  const create = async () => {
    stop.current = false; setErr(''); setPlan(null); setFlags([]); setPhase('plan');
    try {
      const r = await omni.post('/gs/marketing/studio/plan', { prompt, kind, scenes, date, ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) });
      setPlan(r.plan); setFlags(r.flags || []); setWhen((w) => ({ ...w, date: r.plan.date || tomorrow() }));
      setPhase('pics'); const ids = [];
      for (let i = 0; i < r.plan.scenes.length; i += 1) {
        setStep({ i: i + 1, n: r.plan.scenes.length });
        ids.push(await makePicture(r.plan.scenes[i])); // eslint-disable-line no-await-in-loop
      }
      setPhase('done');
      toast(isVideo ? 'Pictures ready: putting the video together' : 'Your post pictures are ready as drafts');
      if (isVideo && onVideo) onVideo(r.plan, ids); else if (onMade) onMade();
      if (isVideo && onMade) onMade();
    } catch (e) { if (e.message !== 'stopped') setErr(errOf(e, e.message || 'It could not be created.')); setPhase(''); if (onMade) onMade(); }
  };

  const text = plan ? `${plan.caption}${plan.hashtags.length ? `\n\n${plan.hashtags.join(' ')}` : ''}` : '';
  const addToCalendar = async () => {
    setBusy('cal'); setErr('');
    try { await omni.post('/gs/marketing/calendar', { title: plan.title, platforms: plats, text, date: when.date, time: when.time, status: 'idea', note: `Made from a prompt: ${prompt.slice(0, 200)}` }); toast('Added to the Content Calendar as an idea'); } catch (e) { setErr(errOf(e, 'It could not be added to the Calendar.')); } finally { setBusy(''); }
  };

  return (
    <Panel title="✦ Create from a prompt" sub={isVideo ? 'Type what you want: the topic, who it is for and the day. The AI plans it, makes a picture for every scene, and puts the video together.' : 'Type what you want: the topic, who it is for and the day. The AI writes the post words and makes the pictures.'} style={{ marginBottom: 14 }}
      right={<Btn small onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Open'}</Btn>}>
      {open ? (
        <div>
          {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
          <Field label="WHAT DO YOU WANT?" full hint="For example: A Diwali offer video for our software clients, 20% off all this week, friendly and festive.">
            <textarea rows={3} maxLength={800} value={prompt} disabled={working} onChange={(e) => setPrompt(e.target.value)} placeholder={isVideo ? 'A festive Diwali video for our clients: 20% off, warm colours, ends with "Contact us"' : 'A Republic Day greeting post for our clients, proud and simple'} style={{ width: '100%' }} />
          </Field>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="FOR WHICH DAY (OPTIONAL)"><input type="date" value={date} disabled={working} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={isVideo ? 'SCENES (PICTURES)' : 'PICTURES'}>
              <select value={scenes} disabled={working} onChange={(e) => setScenes(Number(e.target.value))}>{(isVideo ? [3, 4, 5, 6] : [1, 2, 3]).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </Field>
            <Field label="SHAPE">
              <select value={aspect} disabled={working} onChange={(e) => setAspect(e.target.value)}>
                {isVideo ? <><option value="9:16">Tall 9:16 (Reels, Status)</option><option value="16:9">Wide 16:9 (YouTube)</option><option value="1:1">Square 1:1</option></> : <><option value="1:1">Square post 1:1</option><option value="4:5">Instagram portrait 4:5</option><option value="9:16">Story 9:16</option><option value="16:9">Banner 16:9</option></>}
              </select>
            </Field>
            <Btn primary disabled={working || prompt.trim().length < 8} onClick={create}>{working ? 'Creating…' : isVideo ? '✦ Create the video' : '✦ Create the post'}</Btn>
            {working ? <Btn onClick={() => { stop.current = true; }}>Stop</Btn> : null}
          </div>
          {prompt.trim().length < 8 && !working ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Write a sentence about what you want.</div> : null}
          {projectId ? <div style={{ fontSize: 11, color: '#1d4fa8', marginTop: 6 }}>Made for the client project: their logo and colours are used.</div> : null}

          {working || phase === 'done' ? (
            <ol className="mk-steps" style={{ margin: '14px 0 0' }}>
              <li><span className={`dot${phase !== 'plan' ? ' done' : ''}`}>{phase !== 'plan' ? '✓' : ''}</span>{phase === 'plan' ? 'The AI is planning it…' : 'Planned: headline, scenes, caption and hashtags'}</li>
              <li><span className={`dot${phase === 'done' ? ' done' : ''}`}>{phase === 'done' ? '✓' : ''}</span>{phase === 'done' ? `${plan ? plan.scenes.length : ''} picture${plan && plan.scenes.length === 1 ? '' : 's'} made` : phase === 'pics' ? `Making picture ${step.i} of ${step.n}… (about 10 seconds each)` : 'Pictures'}</li>
              {isVideo ? <li><span className="dot" />{phase === 'done' ? 'Putting the video together: watch it below, then Save' : 'The video'}</li> : null}
            </ol>
          ) : null}

          {plan ? (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: 13 }}>{plan.headline}</b> {plan.dateLabel ? <Pill tone="warn">For {plan.dateLabel}</Pill> : null}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 8px' }}>{plan.tagline} · {plan.cta}</div>
              {flags.length ? <div className="mk-flag">Contains words your brand voice says never to use: <b>{flags.join(', ')}</b>. Change them before you post.</div> : null}
              <Field label="POST WORDS (EDIT IF YOU LIKE)" full><textarea style={{ minHeight: 90 }} value={`${plan.caption}${plan.hashtags.length ? `\n\n${plan.hashtags.join(' ')}` : ''}`} onChange={(e) => { const [cap, ...tags] = e.target.value.split(/\n\n(?=#)/); setPlan({ ...plan, caption: cap, hashtags: (tags.join(' ').match(/#[\p{L}\p{N}_]+/gu) || []) }); }} /></Field>
              <ol style={{ margin: '8px 0 0', padding: '0 0 0 18px', fontSize: 11.5, color: '#54645b', lineHeight: 1.6 }}>{plan.scenes.map((s, i) => <li key={i}><b>{s.caption}</b> · {s.imagePrompt}</li>)}</ol>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <Btn small onClick={async () => { try { await navigator.clipboard.writeText(text); toast('Words and hashtags copied'); } catch { window.prompt('Copy the words:', text); } }}>⧉ Copy words + hashtags</Btn>
              </div>
              {phase === 'done' ? (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
                  <Field label="PLAN IT IN THE CONTENT CALENDAR"><input type="date" value={when.date} onChange={(e) => setWhen({ ...when, date: e.target.value })} /></Field>
                  <Field label="TIME"><input type="time" value={when.time} onChange={(e) => setWhen({ ...when, time: e.target.value })} /></Field>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, alignItems: 'center', paddingBottom: 8 }}>{PLATS.slice(0, 3).map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={plats.includes(k)} onChange={() => setPlats((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))} />{l}</label>)}</div>
                  <Btn disabled={busy === 'cal' || !plats.length || !when.date} onClick={addToCalendar}>🗓 Add to the Calendar</Btn>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

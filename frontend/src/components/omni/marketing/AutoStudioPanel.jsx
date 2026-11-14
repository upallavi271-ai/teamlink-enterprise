import { useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { Panel, Btn, Banner, Field, Pill } from '../ui.jsx';
import { designPoster, loadImage } from './designPoster.js';

// "✦ CREATE FROM YOUR CONTENT": a person types an idea (or only their own title, heading and content) and TeamLink makes the pictures and the video BY ITSELF.
//   plan     the AI writes what is missing: headline, scene words, caption, hashtags (marketing/autostudio.js). What the person wrote themselves is always used exactly.
//   pictures DESIGNED (the default, free, no billing): a real free stock photo behind the words, in the brand colours with the logo and a call to action, drawn in the browser.
//            AI-MADE (only when a paid picture AI is connected): one AI picture per scene; if the picture AI refuses (no billing / limit), that scene is designed instead.
//   then     the pictures become a VIDEO (the AI Video page puts them together in the browser: onVideo) or stay as picture POSTS (onMade). Everything lands as a DRAFT that still needs
//            approval (team or client). Nothing is posted from here.
// kind 'video' | 'post'. projectId: made for a client project (its logo and colours are used).
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const PLATS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['linkedin', 'LinkedIn'], ['x', 'X'], ['whatsapp', 'WhatsApp status']];
const tomorrow = () => new Date(Date.now() + 86400000 + 19800000).toISOString().slice(0, 10);
const shapeOf = (aspect) => { const [w, h] = aspect.split(':').map(Number); return h > w * 1.1 ? 'portrait' : w > h * 1.1 ? 'landscape' : 'square'; };
const AI_REFUSED = /billing|quota|limit|not ready|not connected|permission|api key|exceeded|payment|credit/i;

export default function AutoStudioPanel({ kind = 'video', projectId = '', onVideo, onMade, toast }) {
  const isVideo = kind === 'video';
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [heading, setHeading] = useState('');
  const [content, setContent] = useState('');
  const [cta, setCta] = useState('');
  const [date, setDate] = useState('');
  const [scenes, setScenes] = useState(isVideo ? 4 : 2);
  const [aspect, setAspect] = useState(isVideo ? '9:16' : '1:1');
  const [look, setLook] = useState('designed'); // 'designed' (free) | 'ai' (paid picture AI)
  const [photos, setPhotos] = useState(true);
  const [phase, setPhase] = useState(''); // '' | 'plan' | 'pics' | 'done'
  const [step, setStep] = useState({ i: 0, n: 0 });
  const [plan, setPlan] = useState(null);
  const [flags, setFlags] = useState([]);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(true);
  const [more, setMore] = useState(false);
  const [thumbs, setThumbs] = useState([]);
  const [plats, setPlats] = useState(['instagram', 'facebook']);
  const [when, setWhen] = useState({ date: '', time: '10:00' });
  const [busy, setBusy] = useState('');
  const [kit, setKit] = useState({ colors: null, logo: null, brandName: '', footer: '' }); // the brand (or the client project's) colours, logo and name
  const [can, setCan] = useState({ stock: false, ai: false });
  const stop = useRef(false);
  const urls = useRef([]);
  useEffect(() => () => { stop.current = true; urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);
  useEffect(() => {
    omni.get('/gs/marketing/stock/meta').then((m) => setCan((c) => ({ ...c, stock: !!m.ready }))).catch(() => {});
    omni.get('/gs/marketing/meta').then((m) => setCan((c) => ({ ...c, ai: !!(m.ai && m.ai.image && m.ai.image.ready && !m.ai.image.demo) }))).catch(() => {});
    const useBrand = () => Promise.all([omni.get('/gs/marketing/brand'), omni.get('/gs/marketing/brand/logo').catch(() => ({ logo: null }))]).then(([b, l]) => ({ colors: b.brand.colors, brandName: b.brand.brandName, footer: [b.brand.website, b.brand.contact].filter(Boolean).join('  ·  '), logoUrl: l.logo ? l.logo.dataUrl : '' }));
    const go = projectId
      ? omni.get(`/gs/marketing/projects/${projectId}`).then(async (x) => { const base = await useBrand().catch(() => ({ colors: null, brandName: '', footer: '', logoUrl: '' })); const p = x.project; return { colors: { ...(base.colors || {}), ...(p.colors && p.colors.primary ? { primary: p.colors.primary } : {}), ...(p.colors && p.colors.secondary ? { secondary: p.colors.secondary } : {}) }, brandName: p.clientName, footer: [(p.handles || '').split('\n')[0], p.contactPhone].filter(Boolean).join('  ·  '), logoUrl: x.logo || '' }; }).catch(() => useBrand())
      : useBrand();
    go.then(async (k) => { let logo = null; if (k.logoUrl) { try { logo = await loadImage(k.logoUrl); } catch { logo = null; } } setKit({ colors: k.colors, logo, brandName: k.brandName, footer: k.footer }); }).catch(() => {});
  }, [projectId]);
  const working = phase === 'plan' || phase === 'pics';

  // an AI picture for one scene: start the job, then ask every 3 seconds until it is done (the same way the AI Images page does). A "too many in a minute" answer waits and tries again.
  const makeAiPicture = async (scene) => {
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
        if (Date.now() - t0 > 4 * 60000) throw new Error('A picture is taking too long.');
        try { job = (await omni.get(`/gs/marketing/images/jobs/${job.id}`)).job; } catch (e) { if (e.response && e.response.status === 404) throw new Error('The picture job was lost.'); } // eslint-disable-line no-await-in-loop
      }
      if (!job || job.status === 'failed') throw new Error((job && job.error) || 'A picture could not be made.');
      return job.items[0].id;
    }
    throw new Error('Too many picture requests in a minute.');
  };

  // a DESIGNED picture for one scene: a free stock photo behind the words (or the brand colours), drawn here and saved as a draft picture
  const makeDesigned = async (p, i, total) => {
    let bg = null;
    if (photos && can.stock) {
      try { const b = await omni.blob('/gs/marketing/stock/photo', { q: p.scenes[i].search || p.scenes[i].caption, shape: shapeOf(aspect), n: i }); bg = await loadImage(b); } catch { bg = null; } // no photo found: the brand colours are used
    }
    const last = i === total - 1; const first = i === 0;
    const heading = first ? p.headline : (p.scenes[i].caption || p.headline);
    const line = first ? (p.scenes[i].caption && p.scenes[i].caption !== p.headline ? p.scenes[i].caption : '') : '';
    const blob = await designPoster({ aspect, bg, colors: kit.colors, logo: kit.logo, heading, line, cta: last ? p.cta : '', footer: last ? (kit.footer || kit.brandName) : kit.brandName, index: i, total });
    const q = new URLSearchParams({ title: `${p.title} · ${i + 1}`.slice(0, 80), ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) });
    const r = await omni.post(`/gs/marketing/images/upload?${q.toString()}`, blob, { headers: { 'Content-Type': 'image/jpeg' } });
    const u = URL.createObjectURL(blob); urls.current.push(u); setThumbs((t) => [...t, u]);
    return r.item.id;
  };

  const create = async () => {
    stop.current = false; setErr(''); setNote(''); setPlan(null); setFlags([]); setThumbs([]); setPhase('plan');
    try {
      const r = await omni.post('/gs/marketing/studio/plan', { prompt, title, heading, content, cta, kind, scenes, date, ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) });
      setPlan(r.plan); setFlags(r.flags || []); setWhen((w) => ({ ...w, date: r.plan.date || tomorrow() }));
      setPhase('pics'); const ids = []; let useAi = look === 'ai' && can.ai; let anyDesigned = false;
      for (let i = 0; i < r.plan.scenes.length; i += 1) {
        setStep({ i: i + 1, n: r.plan.scenes.length });
        let id = null;
        if (useAi) {
          try { id = await makeAiPicture(r.plan.scenes[i]); const t = await omni.blob(`/gs/marketing/images/${id}/file`).catch(() => null); if (t) { const u = URL.createObjectURL(t); urls.current.push(u); setThumbs((x) => [...x, u]); } } catch (e) { // eslint-disable-line no-await-in-loop
            if (e.message === 'stopped') throw e;
            if (AI_REFUSED.test(errOf(e, e.message || ''))) { useAi = false; setNote('The AI picture service said no (it is not set up, or it needs billing). The pictures are designed here instead: free, with your words, logo and colours.'); } else throw e;
          }
        }
        if (!id) { id = await makeDesigned(r.plan, i, r.plan.scenes.length); anyDesigned = true; } // eslint-disable-line no-await-in-loop
        ids.push(id);
        if (stop.current) throw new Error('stopped');
      }
      setPhase('done');
      toast(isVideo ? 'Pictures ready: putting the video together' : 'Your post pictures are ready as drafts');
      if (isVideo && onVideo) onVideo(r.plan, ids, anyDesigned); else if (onMade) onMade();
      if (isVideo && onMade) onMade();
    } catch (e) { if (e.message !== 'stopped') setErr(errOf(e, e.message || 'It could not be created.')); setPhase(''); if (onMade) onMade(); }
  };

  const text = plan ? `${plan.caption}${plan.hashtags.length ? `\n\n${plan.hashtags.join(' ')}` : ''}` : '';
  const addToCalendar = async () => {
    setBusy('cal'); setErr('');
    try { await omni.post('/gs/marketing/calendar', { title: plan.title, platforms: plats, text, date: when.date, time: when.time, status: 'idea', note: `Made from: ${(prompt || heading || title).slice(0, 200)}` }); toast('Added to the Content Calendar as an idea'); } catch (e) { setErr(errOf(e, 'It could not be added to the Calendar.')); } finally { setBusy(''); }
  };
  const mine = prompt.trim().length >= 8 || (title.trim() + heading.trim() + content.trim()).length >= 8;

  return (
    <Panel title="✦ Create from your content" sub={isVideo ? 'Type your idea, and your own title, heading and words if you have them. TeamLink makes the pictures and puts the video together by itself: free, no paid AI needed.' : 'Type your idea, and your own title, heading and words if you have them. TeamLink makes the post pictures by itself: free, no paid AI needed.'} style={{ marginBottom: 14 }}
      right={<Btn small onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Open'}</Btn>}>
      {open ? (
        <div>
          {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
          <Field label="YOUR IDEA OR CONCEPT" full hint="For example: A Diwali offer video for our software clients, 20% off all this week, friendly and festive. You can leave this empty if you fill in the title, heading and content below.">
            <textarea rows={3} maxLength={800} value={prompt} disabled={working} onChange={(e) => setPrompt(e.target.value)} placeholder={isVideo ? 'We are hiring freshers: staffing consultancy, join us, apply today' : 'A Republic Day greeting post for our clients, proud and simple'} style={{ width: '100%' }} />
          </Field>
          <div className="form-grid" style={{ marginTop: 6 }}>
            <Field label="TITLE (OPTIONAL)"><input value={title} maxLength={80} disabled={working} onChange={(e) => setTitle(e.target.value)} placeholder="Names it in your list" /></Field>
            <Field label="HEADING (OPTIONAL)"><input value={heading} maxLength={80} disabled={working} onChange={(e) => setHeading(e.target.value)} placeholder="The big line on the first picture" /></Field>
            <Field label="CONTENT (OPTIONAL)" full hint="Your own words, one line for each picture. They are used exactly as you write them.">
              <textarea rows={3} maxLength={1200} value={content} disabled={working} onChange={(e) => setContent(e.target.value)} placeholder={'Freshers welcome\nStaffing consultancy you can trust\nSend your CV today'} style={{ width: '100%' }} />
            </Field>
            <Field label="CALL TO ACTION (OPTIONAL)"><input value={cta} maxLength={30} disabled={working} onChange={(e) => setCta(e.target.value)} placeholder="Apply now" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
            <Field label="FOR WHICH DAY (OPTIONAL)"><input type="date" value={date} disabled={working} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={isVideo ? 'SCENES (PICTURES)' : 'PICTURES'}>
              <select value={scenes} disabled={working} onChange={(e) => setScenes(Number(e.target.value))}>{(isVideo ? [3, 4, 5, 6] : [1, 2, 3]).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </Field>
            <Field label="SHAPE">
              <select value={aspect} disabled={working} onChange={(e) => setAspect(e.target.value)}>
                {isVideo ? <><option value="9:16">Tall 9:16 (Reels, Status)</option><option value="16:9">Wide 16:9 (YouTube)</option><option value="1:1">Square 1:1</option></> : <><option value="1:1">Square post 1:1</option><option value="4:5">Instagram portrait 4:5</option><option value="9:16">Story 9:16</option><option value="16:9">Banner 16:9</option></>}
              </select>
            </Field>
            <Btn primary disabled={working || !mine} onClick={create}>{working ? 'Creating…' : isVideo ? '✦ Create the video' : '✦ Create the post'}</Btn>
            {working ? <Btn onClick={() => { stop.current = true; }}>Stop</Btn> : null}
            <button type="button" className="link-btn" style={{ fontSize: 11.5, paddingBottom: 9 }} onClick={() => setMore(!more)}>{more ? 'Fewer options' : 'More options'}</button>
          </div>
          {more ? (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 12, alignItems: 'center' }}>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={photos} disabled={working || !can.stock} onChange={(e) => setPhotos(e.target.checked)} />Free stock photos behind the words {can.stock ? '' : <span style={{ color: 'var(--muted)' }}>(not set up: an Admin adds a free Pixabay key in Administration &gt; Integrations; brand colours are used)</span>}</label>
              {can.ai ? <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>Pictures: <select value={look} disabled={working} onChange={(e) => setLook(e.target.value)}><option value="designed">Designed by TeamLink (free)</option><option value="ai">Made by the AI picture service (paid)</option></select></label> : <span style={{ color: 'var(--muted)' }}>Pictures are designed by TeamLink (free). AI-made pictures need a paid picture service, which is not connected.</span>}
            </div>
          ) : null}
          {!mine && !working ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Write your idea in a sentence, or fill in the title, heading and content.</div> : null}
          {projectId ? <div style={{ fontSize: 11, color: '#1d4fa8', marginTop: 6 }}>Made for the client project: their logo and colours are used.</div> : null}
          {note ? <div style={{ fontSize: 11.5, color: '#92400e', marginTop: 8, lineHeight: 1.5 }}>{note}</div> : null}

          {working || phase === 'done' ? (
            <ol className="mk-steps" style={{ margin: '14px 0 0' }}>
              <li><span className={`dot${phase !== 'plan' ? ' done' : ''}`}>{phase !== 'plan' ? '✓' : ''}</span>{phase === 'plan' ? 'The AI is planning it…' : 'Planned: headline, scenes, caption and hashtags'}</li>
              <li><span className={`dot${phase === 'done' ? ' done' : ''}`}>{phase === 'done' ? '✓' : ''}</span>{phase === 'done' ? `${plan ? plan.scenes.length : ''} picture${plan && plan.scenes.length === 1 ? '' : 's'} made` : phase === 'pics' ? `Making picture ${step.i} of ${step.n}…` : 'Pictures'}</li>
              {isVideo ? <li><span className="dot" />{phase === 'done' ? 'Putting the video together: watch it below, then Save' : 'The video'}</li> : null}
            </ol>
          ) : null}
          {thumbs.length ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>{thumbs.map((u, i) => <img key={u} src={u} alt={`Picture ${i + 1}`} style={{ height: 150, borderRadius: 8, border: '1px solid var(--line)' }} />)}</div> : null}

          {plan ? (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: 13 }}>{plan.headline}</b> {plan.dateLabel ? <Pill tone="warn">For {plan.dateLabel}</Pill> : null}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 8px' }}>{plan.tagline} · {plan.cta}</div>
              {flags.length ? <div className="mk-flag">Contains words your brand voice says never to use: <b>{flags.join(', ')}</b>. Change them before you post.</div> : null}
              <Field label="POST WORDS (EDIT IF YOU LIKE)" full><textarea style={{ minHeight: 90 }} value={`${plan.caption}${plan.hashtags.length ? `\n\n${plan.hashtags.join(' ')}` : ''}`} onChange={(e) => { const [cap, ...tags] = e.target.value.split(/\n\n(?=#)/); setPlan({ ...plan, caption: cap, hashtags: (tags.join(' ').match(/#[\p{L}\p{N}_]+/gu) || []) }); }} /></Field>
              <ol style={{ margin: '8px 0 0', padding: '0 0 0 18px', fontSize: 11.5, color: '#54645b', lineHeight: 1.6 }}>{plan.scenes.map((s, i) => <li key={i}><b>{s.caption}</b>{s.search ? <> · background: {s.search}</> : null}</li>)}</ol>
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

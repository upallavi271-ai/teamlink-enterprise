import { useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { Panel, Btn, Banner, Field, Pill, TinyBtn } from '../ui.jsx';
import { designPoster, loadImage } from './designPoster.js';
import AutoSendBox, { useAutoSend } from './AutoSendBox.jsx';
import IdeaAssist from './IdeaAssist.jsx';

// "✦ CREATE FROM YOUR CONTENT": a person types an idea (or only their own title, heading and content) and TeamLink makes the pictures and the video BY ITSELF.
//   plan     the AI writes what is missing: headline, scene words, caption, hashtags (marketing/autostudio.js). What the person wrote themselves is always used exactly.
//   pictures DESIGNED (the default, free, no billing): a real free stock photo behind the words, in the brand colours with the logo and a call to action, drawn in the browser.
//            AI-MADE (only when a paid picture AI is connected): one AI picture per scene; if the picture AI refuses (no billing / limit), that scene is designed instead.
//   then     the pictures become a VIDEO (the AI Video page puts them together in the browser: onVideo) or stay as picture POSTS (onMade). Everything lands as a DRAFT that still needs
//            approval (team or client). Nothing is posted from here.
// kind 'video' | 'post'. projectId: made for a client project (its logo and colours are used).
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const shapeOf = (aspect) => { const [w, h] = aspect.split(':').map(Number); return h > w * 1.1 ? 'portrait' : w > h * 1.1 ? 'landscape' : 'square'; };
const AI_REFUSED = /billing|quota|limit|not ready|not connected|permission|api key|exceeded|payment|credit/i;
// one-press starting ideas for a post (they only fill the idea and the heading; the person can change both)
const STARTERS = [
  { label: 'Hiring poster', idea: 'We are hiring for several roles: staffing consultancy, join our team, send your CV today', heading: 'We are hiring' },
  { label: 'Walk-in drive', idea: 'Walk-in interview drive this Saturday for job seekers: bring your CV and ID, come to our office', heading: 'Walk-in drive this Saturday' },
  { label: 'Nurses', idea: 'Staff nurses wanted at hospitals: good salary, immediate joining, apply now', heading: 'Staff nurses wanted' },
  { label: 'Job tip', idea: 'Three simple resume tips for job seekers', heading: '3 resume tips' },
  { label: 'Festival greeting', idea: 'A warm festival greeting post from our team to our clients, calm and festive', heading: 'Happy Diwali' },
  { label: 'Team culture', idea: 'A short post about our team and our work culture', heading: '' },
];

export default function AutoStudioPanel({ kind = 'video', projectId = '', onVideo, onMade, toast }) {
  const isVideo = kind === 'video';
  const auto = useAutoSend(toast); // 2026-11-23: send what is made to a chosen client on WhatsApp by itself (off until ticked; not for a client project, which has its own Send)
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
  const [aiHero, setAiHero] = useState(true); // banners: the hero picture is made by the picture AI (when one is connected), like a designed poster's artwork; a free stock photo otherwise
  const [banners, setBanners] = useState(true); // posts: a professional banner (logo band, two-tone headline, hero picture, icons, who it is for, website), not a plain poster
  const [footage, setFootage] = useState(true); // explainer videos: real stock VIDEO footage behind the words (free), not still pictures
  const [phase, setPhase] = useState(''); // '' | 'plan' | 'pics' | 'done'
  const [step, setStep] = useState({ i: 0, n: 0 });
  const [plan, setPlan] = useState(null);
  const [flags, setFlags] = useState([]);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(true);
  const [more, setMore] = useState(false);
  const [fresh, setFresh] = useState(false); // true: write the video fresh with the AI writer instead of using the project's starter content
  const [thumbs, setThumbs] = useState([]);
  const [kit, setKit] = useState({ colors: null, logo: null, brandName: '', footer: '' }); // the brand (or the client project's) colours, logo and name
  const [can, setCan] = useState({ stock: false, ai: false, aiFree: false });
  const [brief, setBrief] = useState(null); // the client project's own brief: with no idea typed, the video is written from it
  const stop = useRef(false);
  const urls = useRef([]);
  useEffect(() => () => { stop.current = true; urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);
  useEffect(() => {
    omni.get('/gs/marketing/stock/meta').then((m) => setCan((c) => ({ ...c, stock: !!m.ready, stockChecked: true }))).catch(() => {});
    omni.get('/gs/marketing/meta').then((m) => setCan((c) => ({ ...c, ai: !!(m.ai && m.ai.image && m.ai.image.ready && !m.ai.image.demo), aiFree: !!(m.ai && m.ai.image && m.ai.image.ready && m.ai.image.provider === 'cloudflare') }))).catch(() => {});
    const useBrand = () => Promise.all([omni.get('/gs/marketing/brand'), omni.get('/gs/marketing/brand/logo').catch(() => ({ logo: null }))]).then(([b, l]) => ({ colors: b.brand.colors, brandName: b.brand.brandName, footer: [b.brand.website, b.brand.contact].filter(Boolean).join('  ·  '), logoUrl: l.logo ? l.logo.dataUrl : '' }));
    const go = projectId
      ? omni.get(`/gs/marketing/projects/${projectId}`).then(async (x) => { setBrief({ clientName: x.project.clientName, occasion: x.project.occasion, text: x.project.brief || '', draft: x.project.draft || null, ideas: x.ideas || [] }); const base = await useBrand().catch(() => ({ colors: null, brandName: '', footer: '', logoUrl: '' })); const p = x.project; return { colors: { ...(base.colors || {}), ...(p.colors && p.colors.primary ? { primary: p.colors.primary } : {}), ...(p.colors && p.colors.secondary ? { secondary: p.colors.secondary } : {}) }, brandName: p.clientName, footer: [(p.handles || '').split('\n')[0], p.contactPhone].filter(Boolean).join('  ·  '), logoUrl: x.logo || '' }; }).catch(() => useBrand())
      : useBrand();
    go.then(async (k) => { let logo = null; if (k.logoUrl) { try { logo = await loadImage(k.logoUrl); } catch { logo = null; } } setKit({ colors: k.colors, logo, brandName: k.brandName, footer: k.footer }); }).catch(() => {});
  }, [projectId]);
  const working = phase === 'plan' || phase === 'pics';

  // an AI picture for one scene: start the job, then ask every 3 seconds until it is done (the same way the AI Images page does). A "too many in a minute" answer waits and tries again.
  const makeAiPicture = async (scene, asp = aspect) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let r;
      try { r = await omni.post('/gs/marketing/images', { prompt: scene.imagePrompt, headline: '', style: 'photo', aspect: asp, count: 1, useColors: true, withLogo: !isVideo, ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) }); } catch (e) {
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
    const bullets = p.scenes[i].bullets && p.scenes[i].bullets.length ? p.scenes[i].bullets : null; // an explainer scene: its title and rows (designPoster draws them)
    const line = first ? (p.scenes[i].caption && p.scenes[i].caption !== p.headline ? p.scenes[i].caption : '') : '';
    const blob = await designPoster({ aspect, bg, colors: kit.colors, logo: kit.logo, heading: bullets ? (p.scenes[i].caption || heading) : heading, line: bullets ? '' : line, bullets, cta: last ? p.cta : '', footer: last ? (kit.footer || kit.brandName) : kit.brandName, index: i, total });
    const q = new URLSearchParams({ title: `${p.title} · ${i + 1}`.slice(0, 80), ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) });
    const r = await omni.post(`/gs/marketing/images/upload?${q.toString()}`, blob, { headers: { 'Content-Type': 'image/jpeg' } });
    const u = URL.createObjectURL(blob); urls.current.push(u); setThumbs((t) => [...t, u]);
    return r.item.id;
  };

  // a PROFESSIONAL BANNER for one picture of a post (the server designs it: marketing/banner.js showcase layout; the hero picture is a free stock photo, or the AI picture when one was made)
  // the short points of the post words (one tip a line: "Brush twice a day"), without emoji, bullets, hashtags or phone numbers; at most 6, each cut at a word
  const tipsOf = (p) => {
    const key = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/ +/g, ' ').trim();
    const skip = new Set([key(p.headline), key(p.tagline)]);
    const out = [];
    String(p.caption || '').split(/\n+/).forEach((raw) => {
      let t = raw.replace(/\p{Extended_Pictographic}|️|‍/gu, ' ').replace(/^[\s\-•*·\d.)]+/, '').replace(/#\S+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t || /\d{6,}/.test(t) || /^(contact|call|book|follow)\b/i.test(t)) return;
      const clause = t.split(/[:;]|[.!?]\s/)[0].trim();
      t = clause.length >= 6 ? clause : t;
      if (t.length > 40) { const cut = t.slice(0, 40); t = cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)); }
      t = t.replace(/[\s,.!?-]+$/, '');
      if (t.length >= 4 && !skip.has(key(t)) && !out.some((x) => key(x) === key(t))) out.push(t);
    });
    return out.slice(0, 6);
  };
  // the line under the headline: the first sentence of the post words that is not the headline itself ("Your smile deserves a little care every day")
  const subOf = (p) => {
    const first = String(p.caption || '').split(/\n+/)[0].replace(/\p{Extended_Pictographic}|️|‍/gu, ' ').replace(/#\S+/g, ' ').replace(/\s+/g, ' ').trim();
    const head = String(p.headline || '').replace(/\s+/g, ' ').trim();
    let rest = first.toLowerCase().startsWith(head.toLowerCase()) ? first.slice(head.length) : first;
    rest = rest.replace(/^[\s.!?:,;-]+/, '').trim();
    const one = rest.split(/(?<=[.!?])\s/)[0] || '';
    return one.length >= 12 && one.length <= 100 ? one : '';
  };
  const makeBanner = async (p, i, total, heroId) => {
    const sc = p.scenes[i];
    const words = String((i === 0 ? p.headline : sc.caption) || p.headline || '').replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, ' ').split(/\s+/).filter(Boolean);
    const cut = words.length >= 3 ? Math.ceil(words.length / 2) : words.length;
    const site = String(kit.footer || '').split('·')[0].trim();
    const body = {
      size: ['1:1', '4:5', '9:16', '16:9'].includes(aspect) ? aspect : '1:1', layout: 'showcase', title: String(p.title + ' · ' + (i + 1)).slice(0, 80),
      companyName: kit.brandName || undefined, headline: words.slice(0, cut).join(' '), headline2: words.slice(cut).join(' '), sub: i === 0 ? subOf(p) : '',
      services: i === 0 ? (tipsOf(p).length >= 2 ? tipsOf(p) : []) : [], servicesTitle: i === 0 && tipsOf(p).length >= 2 ? 'Simple tips' : '',
      audienceTitle: p.audience ? 'Who it is for:' : '', audience: p.audience || '', chip: site && !/\s/.test(site) ? (/\.[a-z]{2,}(\/.*)?$/i.test(site) ? site : '@' + site.replace(/^@/, '')) : '',
      ...(heroId ? { photoItemId: heroId } : { heroSearch: sc.search || sc.caption, heroN: i }), ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}),
    };
    const r = await omni.post('/gs/marketing/banners', body);
    const t = await omni.blob('/gs/marketing/images/' + r.item.id + '/file').catch(() => null);
    if (t) { const u = URL.createObjectURL(t); urls.current.push(u); setThumbs((x) => [...x, u]); }
    return r.item.id;
  };

  const create = async () => {
    stop.current = false; setErr(''); setNote(''); setPlan(null); setFlags([]); setThumbs([]); setPhase('plan');
    try {
      const r = await omni.post('/gs/marketing/studio/plan', { prompt, title, heading, content, cta, kind, scenes, date, ...(projectId && brief && brief.draft && !fresh ? { useDraft: true } : {}), ...(projectId ? { projectId } : {}), ...(getState().dept ? { department: getState().dept } : {}) });
      setPlan(r.plan); setFlags(r.flags || []);
      if (r.note) setNote(r.note); // the AI writer was busy: the server made the post from the person's own words
      setPhase('pics'); const ids = []; let useAi = look === 'ai' && can.ai; let heroAi = aiHero && can.ai && !isVideo && banners; let anyDesigned = false;
      for (let i = 0; i < r.plan.scenes.length; i += 1) {
        setStep({ i: i + 1, n: r.plan.scenes.length });
        let id = null;
        if (useAi) {
          try { id = await makeAiPicture(r.plan.scenes[i]); const t = await omni.blob(`/gs/marketing/images/${id}/file`).catch(() => null); if (t) { const u = URL.createObjectURL(t); urls.current.push(u); setThumbs((x) => [...x, u]); } } catch (e) { // eslint-disable-line no-await-in-loop
            if (e.message === 'stopped') throw e;
            if (AI_REFUSED.test(errOf(e, e.message || ''))) { useAi = false; setNote('The AI picture service said no (it is not set up, or it needs billing). The pictures are designed here instead: free, with your words, logo and colours.'); } else throw e;
          }
        }
        if (!id && isVideo && footage && can.stock) { // real moving footage from the free stock source, kept in this browser only: for EVERY video now, not only the explainers (owner, 24 Nov: "it keeps pictures as the video, it should be real clips"); a scene whose clip cannot be found stays a designed picture
          try { const cb = await omni.blob('/gs/marketing/stock/clipfile', { q: r.plan.scenes[i].search || r.plan.scenes[i].caption, shape: shapeOf(aspect), n: i }); const cu = URL.createObjectURL(cb); urls.current.push(cu); id = { stock: true, url: cu }; } catch { id = null; } // eslint-disable-line no-await-in-loop
        }
        if (!id && !isVideo && banners) {
          let hero = null;
          if (heroAi) { // the hero artwork: a clean, modern, text-free picture of the subject, in a wide frame (the banner's picture area is wide)
            try { hero = await makeAiPicture({ imagePrompt: 'Professional digital marketing hero artwork for ' + (r.plan.who || 'a business') + ': ' + (r.plan.scenes[i].imagePrompt || r.plan.scenes[i].caption) + '. Clean modern infographic style, glowing blue and gold accents, soft depth of field, polished 3D look. No text, no letters, no logos, no watermark.' }, '16:9'); } catch (e) { // eslint-disable-line no-await-in-loop
              if (e.message === 'stopped') throw e;
              hero = null; if (AI_REFUSED.test(errOf(e, e.message || ''))) { heroAi = false; setNote('The picture AI said no (limit or billing), so the hero pictures are free stock photos instead.'); }
            }
          }
          try { id = await makeBanner(r.plan, i, r.plan.scenes.length, hero); } catch (e) { id = null; if (e.response && e.response.status === 403) throw e; } } // a banner that cannot be designed falls back to the plain picture below
        if (!id) { id = await makeDesigned(r.plan, i, r.plan.scenes.length); anyDesigned = true; } // eslint-disable-line no-await-in-loop
        ids.push(id);
        if (stop.current) throw new Error('stopped');
      }
      setPhase('done');
      toast(isVideo ? 'Pictures ready: putting the video together' : 'Your post pictures are ready as drafts');
      if (isVideo && onVideo) onVideo(r.plan, ids, anyDesigned); else { if (onMade) onMade(); if (!projectId && !isVideo) auto.send(ids); }
      if (isVideo && onMade) onMade();
    } catch (e) { if (e.message !== 'stopped') setErr(errOf(e, e.message || 'It could not be created.')); setPhase(''); if (onMade) onMade(); }
  };

  const text = plan ? `${plan.caption}${plan.hashtags.length ? `\n\n${plan.hashtags.join(' ')}` : ''}` : '';
  const ownWords = prompt.trim().length >= 8; // the idea is REQUIRED (owner, 24 Nov 2026): a title, heading or content alone no longer starts it: ✨ AI Assist writes the idea from them
  const fromBrief = !ownWords && !!(brief && brief.text.trim().length >= 10); // nothing typed, a client brief exists: TeamLink writes the video from the brief
  const mine = ownWords || fromBrief;

  return (
    <>
    {!projectId ? <AutoSendBox auto={auto} /> : null}
    <Panel title="✦ Create from your content" sub={isVideo ? 'Type your idea, and your own title, heading and words if you have them. TeamLink makes the pictures and puts the video together by itself: free, no paid AI needed.' : 'Type your idea, and your own title, heading and words if you have them. TeamLink makes the post pictures by itself: free, no paid AI needed.'} style={{ marginBottom: 14 }}
      right={<Btn small onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Open'}</Btn>}>
      {open ? (
        <div>
          {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
          {!isVideo ? (
            <div className="mk-revise" style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700 }}>START FROM:</span>
              {STARTERS.map((s) => <TinyBtn key={s.label} disabled={working} onClick={() => { setPrompt(s.idea); setHeading(s.heading); }}>{s.label}</TinyBtn>)}
            </div>
          ) : null}
          {brief && brief.text.trim() ? (
            <div style={{ background: '#eef6ff', border: '1px solid #c7ddf7', borderRadius: 10, padding: '9px 12px', margin: '0 0 10px', fontSize: 12 }}>
              <b>The client's brief ({brief.clientName}{brief.occasion ? `, ${brief.occasion}` : ''}):</b> {brief.text.length > 260 ? `${brief.text.slice(0, 260)}…` : brief.text}
              {brief.ideas && brief.ideas.length ? (
                <div style={{ marginTop: 8 }}>
                  <b>Ideas read from the brief</b> <span style={{ color: 'var(--muted)' }}>(press one to use it, or leave them all and make the overview):</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                    <TinyBtn disabled={working} onClick={() => { setPrompt(''); setHeading(''); }}>Everything in the brief</TinyBtn>
                    {brief.ideas.map((x) => <TinyBtn key={x.label} disabled={working} onClick={() => { setPrompt(x.idea); setHeading(x.heading); }} title={x.idea}>{x.label}</TinyBtn>)}
                  </div>
                </div>
              ) : null}
              {brief.draft ? (
                <div style={{ marginTop: 6, padding: '6px 9px', background: '#fff', border: '1px solid #c7ddf7', borderRadius: 8 }}>
                  <b>Starter content, already written for this project:</b> “{brief.draft.headline}”
                  <ol style={{ margin: '4px 0 0 16px', padding: 0 }}>{brief.draft.scenes.map((t, i) => <li key={i}>{t}</li>)}</ol>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, fontSize: 11 }}><input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />Write it fresh with the AI writer instead (slower, uses this brief's own details)</label>
                </div>
              ) : null}
              <div style={{ marginTop: 4, color: 'var(--muted)' }}>Leave the idea below empty and press <b>Create</b>: TeamLink reads this brief and writes the {isVideo ? 'video' : 'post'} for the client's own customers, with useful points, real photos and a call to action, free. Type your own words only if you want to change it.</div>
            </div>
          ) : null}
          <div className="form-grid" style={{ marginTop: 6 }}>
            <Field label="TITLE (OPTIONAL)"><input value={title} maxLength={80} disabled={working} onChange={(e) => setTitle(e.target.value)} placeholder="Names it in your list" /></Field>
            <Field label="HEADING (OPTIONAL)"><input value={heading} maxLength={80} disabled={working} onChange={(e) => setHeading(e.target.value)} placeholder="The big line on the first picture" /></Field>
            <Field label="CONTENT" full hint="Your own words, one line for each picture. They are used exactly as you write them. Then press AI Assist under the idea box: it writes the idea from them.">
              <textarea rows={3} maxLength={1200} value={content} disabled={working} onChange={(e) => setContent(e.target.value)} placeholder={'Freshers welcome\nStaffing consultancy you can trust\nSend your CV today'} style={{ width: '100%' }} />
            </Field>
          </div>
          {/* 2026-11-24 (owner): the content box is above, the idea box below and REQUIRED; ✨ AI Assist writes the idea (topic and points, several lines) from the title and content */}
          <Field label="YOUR IDEA OR CONCEPT" full hint="The topic and the main points of the video or post: the more clearly you write them, the better it is made. Write your own, or press AI Assist: it writes them from your title and content above. Then read it and change anything.">
            <textarea rows={7} maxLength={800} value={prompt} disabled={working} onChange={(e) => setPrompt(e.target.value)} placeholder={isVideo ? 'Topic: We are hiring freshers for our staffing consultancy\nPoints:\n- Freshers welcome\n- A staffing consultancy you can trust\n- Send your CV today' : 'Topic: A Republic Day greeting post for our clients\nPoints:\n- Proud and simple\n- Warm wishes from our team'} style={{ width: '100%' }} />
            <IdeaAssist kind={kind} title={title} heading={heading} content={content} idea={prompt} projectId={projectId} clientName={auto.cfg.on ? auto.cfg.clientName : ''} disabled={working} onIdea={setPrompt} />
          </Field>
          <div className="form-grid" style={{ marginTop: 6 }}>
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
            <Btn primary disabled={working || !mine} onClick={create}>{working ? 'Creating…' : fromBrief ? (isVideo ? '✦ Create the video from the brief' : '✦ Create the post from the brief') : isVideo ? '✦ Create the video' : '✦ Create the post'}</Btn>
            {working ? <Btn onClick={() => { stop.current = true; }}>Stop</Btn> : null}
            <button type="button" className="link-btn" style={{ fontSize: 11.5, paddingBottom: 9 }} onClick={() => setMore(!more)}>{more ? 'Fewer options' : 'More options'}</button>
          </div>
          {more ? (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 12, alignItems: 'center' }}>
              {!isVideo && can.ai ? <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={aiHero} disabled={working || !banners} onChange={(e) => setAiHero(e.target.checked)} />Hero picture made by AI (a few a day) instead of a stock photo</label> : null}
              {!isVideo ? <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={banners} disabled={working} onChange={(e) => setBanners(e.target.checked)} />Professional banner (logo, two-colour headline, picture, icons, who it is for, website)</label> : null}
              {isVideo ? <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={footage} disabled={working || !can.stock} onChange={(e) => setFootage(e.target.checked)} />Real video footage behind the words (free stock clips, like a real video)</label> : null}
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={photos} disabled={working || !can.stock} onChange={(e) => setPhotos(e.target.checked)} />Free stock photos behind the words {can.stock ? '' : <span style={{ color: 'var(--muted)' }}>(not set up: an Admin adds a free Pixabay key in Administration &gt; Integrations; brand colours are used)</span>}</label>
              {can.ai ? <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>Pictures: <select value={look} disabled={working} onChange={(e) => setLook(e.target.value)}><option value="designed">Designed by TeamLink (free)</option><option value="ai">{can.aiFree ? 'Made by the AI picture service (free daily allowance)' : 'Made by the AI picture service (may need billing; designed instead if it says no)'}</option></select></label> : <span style={{ color: 'var(--muted)' }}>Pictures are designed by TeamLink (free). A real AI-made picture needs the free Cloudflare picture service: an Admin adds it in Administration &gt; Integrations.</span>}
            </div>
          ) : null}
          {isVideo && can.stockChecked && !can.stock && !working ? <div style={{ fontSize: 11.5, color: '#92400e', marginTop: 6, lineHeight: 1.5 }}>Real video clips are off: the free stock-footage key is not set, so the video is made from designed pictures. An Admin adds the free Pixabay or Pexels key in Administration &gt; Integrations, and then every video uses real clips.</div> : null}
          {!mine && !working ?<div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{projectId ? 'This client project has no brief yet. ' : ''}The idea box is required: write the topic and the points, or write a title or content above and press ✨ AI Assist.</div> : null}
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
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
    </>
  );
}

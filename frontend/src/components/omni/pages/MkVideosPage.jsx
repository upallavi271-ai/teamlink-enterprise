import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { MkStatus, MkImg, downloadMkImg } from '../marketing/mk.jsx';
import { FORMATS, MOTIONS, recordType, timeline, play, drawFrame } from '../marketing/slideshow.js';
import '../marketing/marketing.css';

// AI MARKETING > AI VIDEO: a short video from APPROVED pictures and the person's own video CLIPS, with the brand intro and outro, made and recorded in
// this browser (free). Real motion comes from the clips (made with the Gemini app / a phone / any tool, then uploaded here and approved); pictures
// move too (zoom / pan). The finished video is saved, approved like a picture, and an approved video gets a public link and can go on the Calendar.
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('picture')); i.src = src; });
const loadVid = (src) => new Promise((res, rej) => {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.onloadeddata = () => res(v);
  v.onerror = () => rej(new Error('clip'));
  v.src = src;
});
// the size of a clip as a post size, from its own width and height
const nearestAspect = (w, h) => ['1:1', '4:5', '9:16', '16:9', '3:4'].map((k) => { const [x, y] = k.split(':').map(Number); return { k, d: Math.abs(Math.log((w / h) / (x / y))) }; }).sort((a, b) => a.d - b.d)[0].k;
const readClip = (file) => new Promise((res, rej) => {
  const v = document.createElement('video'); const u = URL.createObjectURL(file);
  v.preload = 'metadata';
  v.onloadedmetadata = () => { URL.revokeObjectURL(u); res({ dur: v.duration, w: v.videoWidth, h: v.videoHeight }); };
  v.onerror = () => { URL.revokeObjectURL(u); rej(new Error('This browser cannot play that video. Use an MP4 made with H.264 (the Gemini app and most phones make that).')); };
  v.src = u;
});
const CLIP_MAX = 40 * 1024 * 1024;

export default function MkVideosPage() {
  const { toast, go } = useOmni();
  const [pics, setPics] = useState(null); // approved pictures
  const [aClips, setAClips] = useState(null); // approved clips
  const [mine, setMine] = useState(null); // every clip and made video this login may see
  const [canWrite, setCanWrite] = useState(false);
  const [brand, setBrand] = useState(null);
  const [logo, setLogo] = useState(null); // HTMLImageElement
  const [err, setErr] = useState('');
  const [pick, setPick] = useState([]); // [{ id, kind: 'image' | 'clip', caption }] in video order
  const [imgs, setImgs] = useState({}); // id -> HTMLImageElement
  const [vids, setVids] = useState({}); // id -> HTMLVideoElement (clips)
  const [f, setF] = useState({ title: '', format: '9:16', secPer: 3, clipSec: 6, motion: 'mixed', keepSound: true, headline: '', tagline: '', cta: '', footer1: '', footer2: '', useLogo: true });
  const [mode, setMode] = useState(''); // '' | 'preview' | 'record'
  const [prog, setProg] = useState(0);
  const [made, setMade] = useState(null); // { blob, url, type }
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState('');
  const [del, setDel] = useState(null);
  const canvasRef = useRef(null);
  const stopRef = useRef(null);
  const urls = useRef([]);
  const fileRef = useRef(null);

  const load = useCallback(() => {
    setErr('');
    omni.get('/gs/marketing/images', { status: 'approved', kind: 'image' }).then((d) => { setPics(d.items || []); setCanWrite(!!d.canWrite); }).catch((e) => setErr(errOf(e, 'The approved pictures could not be read.')));
    omni.get('/gs/marketing/images', { kind: 'video' }).then((d) => { const all = d.items || []; setMine(all); setAClips(all.filter((v) => v.style === 'clip' && v.status === 'approved')); }).catch((e) => setErr(errOf(e, 'The videos could not be read.')));
  }, []);
  useEffect(() => {
    load();
    omni.get('/gs/marketing/brand').then((d) => {
      const b = d.brand; setBrand(b);
      setF((x) => ({ ...x, headline: x.headline || b.tagline || 'We are hiring', tagline: x.tagline || b.brandName || '', cta: x.cta || b.cta || 'Apply now', footer1: x.footer1 || b.website || '', footer2: x.footer2 || b.contact || '' }));
    }).catch(() => setBrand({ brandName: '', colors: { primary: '#0f766e', secondary: '#134e4a', accent: '#f59e0b' } }));
    omni.get('/gs/marketing/brand/logo').then((r) => (r.logo ? loadImg(r.logo.dataUrl).then(setLogo) : null)).catch(() => setLogo(null));
    return () => { if (stopRef.current) stopRef.current(); urls.current.forEach((u) => URL.revokeObjectURL(u)); };
  }, [load]);

  // the picked pictures and clips as drawable media (fetched with the login, shown from blob addresses)
  useEffect(() => {
    pick.forEach(({ id, kind }) => {
      const have = kind === 'clip' ? vids[id] : imgs[id];
      if (have) return;
      omni.blob(`/gs/marketing/images/${id}/file`).then((b) => { const u = URL.createObjectURL(b); urls.current.push(u); return kind === 'clip' ? loadVid(u) : loadImg(u); })
        .then((m) => (kind === 'clip' ? setVids((x) => ({ ...x, [id]: m })) : setImgs((x) => ({ ...x, [id]: m }))))
        .catch(() => toast(kind === 'clip' ? 'A clip could not be loaded: use an MP4 made with H.264' : 'A picture could not be loaded'));
    });
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = FORMATS[f.format];
  const hasClip = pick.some((p) => p.kind === 'clip');
  const data = useMemo(() => brand && ({
    brand: { ...brand, colors: brand.colors || { primary: '#0f766e', secondary: '#134e4a', accent: '#f59e0b' } },
    logo: f.useLogo ? logo : null, headline: f.headline, tagline: f.tagline, cta: f.cta, footer: [f.footer1, f.footer2], motion: f.motion, sound: f.keepSound,
    pics: pick.map((p) => ({ caption: p.caption, kind: p.kind, len: p.kind === 'clip' && vids[p.id] ? vids[p.id].duration : undefined })),
    images: pick.map((p) => (p.kind === 'image' ? imgs[p.id] || null : null)),
    videos: pick.map((p) => (p.kind === 'clip' ? vids[p.id] || null : null)),
  }), [brand, logo, f, pick, imgs, vids]);
  const tl = timeline(data ? data.pics : [], Number(f.secPer), Number(f.clipSec));
  const ready = pick.length > 0 && pick.every((p) => (p.kind === 'clip' ? vids[p.id] : imgs[p.id]));

  // a still of the first scene after the intro whenever something changes and nothing is playing
  useEffect(() => {
    const c = canvasRef.current; if (!c || !data || mode) return;
    drawFrame(c.getContext('2d'), c.width, c.height, pick.length ? tl.scenes[1].start + 0.8 : 1, data, tl);
  }, [data, mode, fmt.w, fmt.h, f.secPer, f.clipSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && (!pics || !mine)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!pics || !mine || !aClips || !brand) return <div className="card panel">Loading…</div>;

  const sources = [...pics.map((p) => ({ ...p, kind: 'image' })), ...aClips.map((c) => ({ ...c, kind: 'clip' }))];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (p) => setPick((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= 8 ? (toast('At most 8 pictures and clips in one video'), cur) : [...cur, { id: p.id, kind: p.kind, caption: p.kind === 'image' ? (p.headline || '') : '' }]));
  const move = (i, d) => setPick((cur) => { const n = [...cur]; const j = i + d; if (j < 0 || j >= n.length) return cur; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const run = (record) => {
    if (!ready) { toast('Pick at least one picture or clip (and wait for it to load)'); return; }
    if (stopRef.current) stopRef.current();
    setMode(record ? 'record' : 'preview'); setProg(0); if (record) setMade(null);
    stopRef.current = play(canvasRef.current, data, {
      secPer: Number(f.secPer), clipSec: Number(f.clipSec), record,
      onProgress: (p) => setProg(p),
      onDone: (blob, why) => {
        stopRef.current = null; setMode('');
        if (why) { toast(why); return; }
        if (record && blob) { const url = URL.createObjectURL(blob); urls.current.push(url); setMade({ blob, url, type: blob.type }); toast('The video is ready: watch it, then save or download it'); }
      },
    });
  };
  const stop = () => { if (stopRef.current) stopRef.current(); };
  const download = () => { const a = document.createElement('a'); a.href = made.url; a.download = `${(f.title || 'video').replace(/[^\w\- ]+/g, '').slice(0, 60) || 'video'}.${made.type.includes('mp4') ? 'mp4' : 'webm'}`; document.body.appendChild(a); a.click(); a.remove(); };
  const save = async (andSubmit) => {
    setBusy(andSubmit ? 'submit' : 'save');
    try {
      const r = await omni.post('/gs/marketing/images/video', made.blob, {
        headers: { 'Content-Type': made.type.split(';')[0] },
        params: { title: f.title || f.headline || 'Video', aspect: f.format, scenes: pick.length, seconds: Math.round(tl.total), logo: f.useLogo && logo ? '1' : '0', headline: f.headline, ...(getState().dept ? { department: getState().dept } : {}) },
        timeout: 300000,
      });
      if (andSubmit) { const s = await omni.post(`/gs/marketing/images/${r.item.id}/submit`); toast(s.ok); } else toast('Video saved');
      setMade(null); setTab(''); load();
    } catch (e) { toast(errOf(e, 'The video could not be saved.')); } finally { setBusy(''); }
  };
  // the person's own clips (made with the Gemini app, a phone ...): up to 3 at a time, each saved as raw footage and approved before it can be used
  const uploadClips = async (e) => {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    if (files.length > 3) { toast('Upload at most 3 clips at a time'); return; }
    setBusy('clips');
    let ok = 0; const failed = [];
    for (const x of files) {
      try {
        if (!/^video\/(mp4|webm)$/.test(x.type)) throw new Error('use an MP4 or WebM clip');
        if (x.size > CLIP_MAX) throw new Error(`too big (${Math.round(x.size / 1048576)} MB): use a clip under 40 MB`);
        const m = await readClip(x); // eslint-disable-line no-await-in-loop
        if (!Number.isFinite(m.dur) || m.dur < 1) throw new Error('the clip is shorter than 1 second');
        if (m.dur > 60) throw new Error(`too long (${Math.round(m.dur)} s): use a clip of up to 60 seconds`);
        await omni.post('/gs/marketing/images/video', x, { headers: { 'Content-Type': x.type }, params: { kind: 'clip', title: x.name, aspect: nearestAspect(m.w, m.h), seconds: Math.round(m.dur), ...(getState().dept ? { department: getState().dept } : {}) }, timeout: 300000 }); // eslint-disable-line no-await-in-loop
        ok += 1;
      } catch (er) { failed.push(`${x.name}: ${errOf(er, er.message || 'not saved')}`); }
    }
    setBusy(''); load();
    toast(`${ok} clip${ok === 1 ? '' : 's'} uploaded${failed.length ? `, ${failed.length} not` : ''}. Ask for approval to use ${ok === 1 ? 'it' : 'them'}.`);
    if (failed.length) setErr(`Not uploaded: ${failed.join(' · ')}`);
  };
  const act = async (it) => { setBusy(it.id); try { const r = await omni.post(`/gs/marketing/images/${it.id}/submit`); toast(r.ok); load(); } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(''); } };
  const remove = async () => { const it = del; setDel(null); try { await omni.del(`/gs/marketing/images/${it.id}`); toast('Deleted'); setPick((cur) => cur.filter((p) => p.id !== it.id)); load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); } };
  const copyLink = async (it) => { const url = `${window.location.origin}${it.publicPath}`; try { await navigator.clipboard.writeText(url); toast('Public link copied'); } catch { window.prompt('Copy the public link:', url); } };
  const type = recordType(false);
  const ratio = (a) => { const [w, h] = String(a || '1:1').split(':').map(Number); return `${w} / ${h}`; };
  const clipsAll = mine.filter((v) => v.style === 'clip');
  const videosAll = mine.filter((v) => v.style !== 'clip');
  const shown = tab ? videosAll.filter((v) => v.status === tab) : videosAll;
  const cnt = (s) => videosAll.filter((v) => v.status === s).length;

  const card = (v, isClip) => (
    <div key={v.id} className="card mki-card">
      <div style={{ aspectRatio: ratio(v.aspect), overflow: 'hidden', borderRadius: 10, background: '#000' }}><MkImg id={v.id} alt={v.title} video style={{ height: '100%', objectFit: 'contain', background: '#000' }} /></div>
      <b style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 8 }} title={v.title}>{v.title}</b>
      <div style={{ margin: '3px 0' }}><MkStatus status={v.status} /></div>
      <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>{v.prompt} · {v.aspect} · {(v.bytes / 1048576).toFixed(1)} MB · {fmtDateTime(v.createdAt)}{!v.mine ? ` · ${v.createdByName}` : ''}</small>
      {v.status === 'changes' && v.note ? <div className="mk-note">Sent back by {v.decidedByName}: {v.note}</div> : null}
      <div className="mk-acts" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <TinyBtn onClick={() => downloadMkImg(v.id, v.title).catch((e) => toast(errOf(e, 'It could not be downloaded.')))}>⬇ Download</TinyBtn>
        {v.canSubmit ? <TinyBtn disabled={busy === v.id} onClick={() => act(v)}>Ask for approval</TinyBtn> : null}
        {v.publicPath ? <TinyBtn onClick={() => copyLink(v)}>🔗 Copy link</TinyBtn> : null}
        {v.canDelete ? <TinyBtn onClick={() => setDel(v)} aria-label={`Delete ${v.title}`}>🗑</TinyBtn> : null}
      </div>
      {isClip && v.status === 'approved' ? <small style={{ fontSize: 9.5, color: '#166534' }}>Ready: pick it in step 1.</small> : null}
    </div>
  );

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI Video" lead="Join approved pictures and your own video clips into one short video with your logo, colours, captions and a call to action. It is made in this browser: free, nothing is sent anywhere until you save it.">
        {canWrite ? (
          <>
            <input ref={fileRef} type="file" accept="video/mp4,video/webm" multiple style={{ display: 'none' }} onChange={uploadClips} />
            <Btn disabled={busy === 'clips'} onClick={() => fileRef.current && fileRef.current.click()} title="MP4 or WebM, up to 60 seconds and 40 MB each, up to 3 at a time. Only clips you made or may use.">{busy === 'clips' ? 'Uploading…' : '⬆ Upload video clips'}</Btn>
          </>
        ) : null}
      </PageHead>
      {!type ? <Banner tone="error">This browser cannot record video. Use a recent Chrome or Edge on a computer.</Banner> : !type.includes('mp4') ? <Banner tone="warn">This browser records WebM, not MP4. WhatsApp and Facebook take WebM; for Instagram use Chrome or Edge, which make MP4.</Banner> : null}
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      {canWrite ? (
        <>
          <Banner tone="info"><b>Want real, moving video?</b> Pictures only zoom or pan. For real motion, make short clips in the <b>Gemini app</b> (gemini.google.com: your plan's video maker, if it has one), a phone or any tool, press <b>⬆ Upload video clips</b>, get them approved, then mix them with pictures below. Clips from the Gemini app often carry sound: you can keep it.</Banner>
          <Panel title="1 · Pick the pictures and clips" sub={sources.length ? `Tap them in the order they should play (up to 8). ${pick.length} picked.` : undefined}>
            {sources.length === 0 ? <Empty title="Nothing approved yet" action={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}><Btn onClick={() => go('mkimages')}>Pictures: AI Images</Btn><Btn onClick={() => fileRef.current && fileRef.current.click()}>⬆ Upload a clip</Btn></div>}>A video is made from approved pictures and approved clips. Make or upload some, ask for approval, then come back.</Empty> : (
              <div className="mki-pick" style={{ maxHeight: 260 }}>
                {sources.map((p) => { const n = pick.findIndex((x) => x.id === p.id); return (
                  <button type="button" key={p.id} className={n >= 0 ? 'on' : ''} title={`${p.kind === 'clip' ? 'Clip: ' : ''}${p.title}`} onClick={() => toggle(p)} style={{ position: 'relative' }}>
                    <MkImg id={p.id} alt={p.title} video={p.kind === 'clip'} controls={false} style={{ height: '100%', borderRadius: 8, ...(p.kind === 'clip' ? { background: '#000' } : {}) }} />
                    {p.kind === 'clip' ? <span style={{ position: 'absolute', bottom: 4, left: 4, background: 'rgba(0,0,0,.65)', color: '#fff', borderRadius: 8, fontSize: 9, fontWeight: 800, padding: '1px 6px' }}>▶ clip</span> : null}
                    {n >= 0 ? <span style={{ position: 'absolute', top: 4, left: 4, background: '#0f766e', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 800, padding: '1px 6px' }}>{n + 1}</span> : null}
                  </button>
                ); })}
              </div>
            )}
          </Panel>

          {pick.length > 0 && (
            <div className="mk-two" style={{ marginTop: 14 }}>
              <Panel title="2 · Words and look" sub={`${Math.round(tl.total)} seconds in all · intro, ${pick.length} scene${pick.length === 1 ? '' : 's'}, outro`}>
                <div className="form-grid">
                  <Field label="NAME OF THE VIDEO" full><input value={f.title} maxLength={80} onChange={set('title')} placeholder="Nurse hiring drive video" /></Field>
                  <Field label="SIZE"><select value={f.format} onChange={set('format')} disabled={!!mode}>{Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
                  <Field label="SECONDS PER PICTURE"><select value={f.secPer} onChange={(e) => setF({ ...f, secPer: Number(e.target.value) })} disabled={!!mode}>{[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
                  <Field label="HOW PICTURES MOVE"><select value={f.motion} onChange={set('motion')} disabled={!!mode}>{Object.entries(MOTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                  {hasClip ? <Field label="SECONDS FROM EACH CLIP" hint="A clip plays from its start, at most this long."><select value={f.clipSec} onChange={(e) => setF({ ...f, clipSec: Number(e.target.value) })} disabled={!!mode}>{[3, 4, 5, 6, 8, 10, 15].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field> : null}
                  {hasClip ? <Field label="CLIP SOUND" full><label style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.keepSound} disabled={!!mode} onChange={(e) => setF({ ...f, keepSound: e.target.checked })} />Keep the clips' own sound <small style={{ color: 'var(--muted)' }}>(while recording, your computer stays quiet; pictures have no sound)</small></label></Field> : null}
                  <Field label="INTRO HEADLINE" full><input value={f.headline} maxLength={70} onChange={set('headline')} /></Field>
                  <Field label="INTRO LINE UNDER IT" full><input value={f.tagline} maxLength={80} onChange={set('tagline')} /></Field>
                  {pick.map((p, i) => (
                    <Field key={p.id} label={<span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{p.kind === 'clip' ? 'CLIP' : 'PICTURE'} {i + 1} CAPTION <TinyBtn onClick={() => move(i, -1)} disabled={i === 0 || !!mode} aria-label="Earlier">↑</TinyBtn><TinyBtn onClick={() => move(i, 1)} disabled={i === pick.length - 1 || !!mode} aria-label="Later">↓</TinyBtn></span>} full>
                      <input value={p.caption} maxLength={90} placeholder="Optional words on this scene" onChange={(e) => setPick((cur) => cur.map((x) => (x.id === p.id ? { ...x, caption: e.target.value } : x)))} />
                    </Field>
                  ))}
                  <Field label="CALL TO ACTION (OUTRO)" full><input value={f.cta} maxLength={60} onChange={set('cta')} /></Field>
                  <Field label="OUTRO LINE 1"><input value={f.footer1} maxLength={80} onChange={set('footer1')} placeholder="Website" /></Field>
                  <Field label="OUTRO LINE 2"><input value={f.footer2} maxLength={80} onChange={set('footer2')} placeholder="Phone or email" /></Field>
                  <Field label="LOGO" full><label style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center', opacity: logo ? 1 : 0.55 }}><input type="checkbox" checked={f.useLogo && !!logo} disabled={!logo} onChange={(e) => setF({ ...f, useLogo: e.target.checked })} />Show our logo {logo ? '' : <button type="button" className="link-btn" onClick={() => go('mkbrand')}>(upload one in Brand voice)</button>}</label></Field>
                </div>
              </Panel>
              <Panel title="3 · Preview and make" sub={mode === 'record' ? 'Recording… keep this tab open and in front.' : 'The video plays in real time while it is made.'}>
                <canvas ref={canvasRef} width={fmt.w} height={fmt.h} style={{ width: '100%', maxWidth: f.format === '16:9' ? 520 : 340, display: 'block', margin: '0 auto', borderRadius: 12, background: '#111', aspectRatio: ratio(f.format) }} aria-label="Video preview" />
                {mode ? <div style={{ height: 6, background: 'var(--line)', borderRadius: 4, marginTop: 8, overflow: 'hidden' }}><div style={{ width: `${Math.round(prog * 100)}%`, height: '100%', background: mode === 'record' ? '#b3261e' : '#0f766e' }} /></div> : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                  {mode ? <Btn onClick={stop}>■ Stop</Btn> : (
                    <>
                      <Btn disabled={!ready} onClick={() => run(false)}>▶ Preview{hasClip && f.keepSound ? ' (with sound)' : ''}</Btn>
                      <Btn primary disabled={!ready || !type} onClick={() => run(true)}>⏺ Make the video ({Math.round(tl.total)}s)</Btn>
                    </>
                  )}
                </div>
                {!ready && pick.length ? <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center', marginTop: 6 }}>Loading the pictures and clips…</div> : null}
                {made ? (
                  <div style={{ marginTop: 12 }}>
                    <video src={made.url} controls playsInline style={{ width: '100%', borderRadius: 10, background: '#000' }} aria-label="The finished video" />
                    <div style={{ fontSize: 10, color: 'var(--muted)', margin: '4px 0 8px' }}>{made.type.includes('mp4') ? 'MP4' : 'WebM'} · {(made.blob.size / 1048576).toFixed(1)} MB</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Btn onClick={download}>⬇ Download</Btn>
                      <Btn disabled={!!busy} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : '💾 Save'}</Btn>
                      <Btn primary disabled={!!busy} onClick={() => save(true)}>{busy === 'submit' ? 'Saving…' : 'Save and ask for approval →'}</Btn>
                    </div>
                  </div>
                ) : null}
              </Panel>
            </div>
          )}
        </>
      ) : <Banner tone="info">You can watch the videos of your department and approve them in Approvals. Only Marketing and Admins make videos.</Banner>}

      {clipsAll.length > 0 ? (
        <Panel title="Your clips" sub="Raw footage you uploaded. A clip needs approval before it can go into a video." style={{ marginTop: 14 }} right={<span className="pill live">{clipsAll.length}</span>}>
          <div className="mki-grid">{clipsAll.map((v) => card(v, true))}</div>
        </Panel>
      ) : null}

      <Panel title="Your videos" sub="Finished videos, newest first" style={{ marginTop: 14 }} right={<span className="pill live">{videosAll.length}</span>}>
        <Tabs value={tab} onChange={setTab} tabs={[['', 'All', videosAll.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="No videos here yet">{videosAll.length ? 'Nothing with that status.' : 'Pick pictures or clips above and press Make the video.'}</Empty> : <div className="mki-grid">{shown.map((v) => card(v, false))}</div>}
      </Panel>
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'Its public link stops working and calendar posts that use it lose it.' : 'It is removed.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}

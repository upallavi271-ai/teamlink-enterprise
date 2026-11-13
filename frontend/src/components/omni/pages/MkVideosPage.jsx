import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { getState } from '../omniStore.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Tabs, Empty, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { MkStatus, MkImg, downloadMkImg } from '../marketing/mk.jsx';
import { FORMATS, recordType, timeline, play, drawFrame } from '../marketing/slideshow.js';
import '../marketing/marketing.css';

// AI MARKETING > AI VIDEO: a short slideshow video from APPROVED pictures, with the brand intro and outro, made and recorded in this browser (free).
// The finished video is saved, then approved like a picture (Approvals); an approved video gets a public link and can be picked in the Content Calendar.
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('picture')); i.src = src; });

export default function MkVideosPage() {
  const { toast, go } = useOmni();
  const [pics, setPics] = useState(null); // approved pictures
  const [videos, setVideos] = useState(null);
  const [canWrite, setCanWrite] = useState(false);
  const [brand, setBrand] = useState(null);
  const [logo, setLogo] = useState(null); // HTMLImageElement
  const [err, setErr] = useState('');
  const [pick, setPick] = useState([]); // [{ id, caption }] in video order
  const [imgs, setImgs] = useState({}); // id -> HTMLImageElement (from blob addresses)
  const [f, setF] = useState({ title: '', format: '1:1', secPer: 3, headline: '', tagline: '', cta: '', footer1: '', footer2: '', useLogo: true });
  const [mode, setMode] = useState(''); // '' | 'preview' | 'record'
  const [prog, setProg] = useState(0);
  const [made, setMade] = useState(null); // { blob, url, type }
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState('');
  const [del, setDel] = useState(null);
  const canvasRef = useRef(null);
  const stopRef = useRef(null);
  const urls = useRef([]);

  const load = useCallback(() => {
    setErr('');
    omni.get('/gs/marketing/images', { status: 'approved', kind: 'image' }).then((d) => { setPics(d.items || []); setCanWrite(!!d.canWrite); }).catch((e) => setErr(errOf(e, 'The approved pictures could not be read.')));
    omni.get('/gs/marketing/images', { kind: 'video' }).then((d) => setVideos(d.items || [])).catch((e) => setErr(errOf(e, 'The videos could not be read.')));
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

  // the picked pictures as drawable images (fetched with the login, shown from blob addresses)
  useEffect(() => {
    pick.forEach(({ id }) => {
      if (imgs[id]) return;
      omni.blob(`/gs/marketing/images/${id}/file`).then((b) => { const u = URL.createObjectURL(b); urls.current.push(u); return loadImg(u); }).then((i) => setImgs((m) => ({ ...m, [id]: i }))).catch(() => toast('A picture could not be loaded'));
    });
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = FORMATS[f.format];
  const data = useMemo(() => brand && ({
    brand: { ...brand, colors: brand.colors || { primary: '#0f766e', secondary: '#134e4a', accent: '#f59e0b' } },
    logo: f.useLogo ? logo : null, headline: f.headline, tagline: f.tagline, cta: f.cta, footer: [f.footer1, f.footer2],
    pics: pick.map((p) => ({ caption: p.caption })), images: pick.map((p) => imgs[p.id] || null),
  }), [brand, logo, f, pick, imgs]);
  const tl = timeline(pick, f.secPer);
  const ready = pick.length > 0 && pick.every((p) => imgs[p.id]);

  // a still of the first picture scene (or the intro) whenever something changes and nothing is playing
  useEffect(() => {
    const c = canvasRef.current; if (!c || !data || mode) return;
    drawFrame(c.getContext('2d'), c.width, c.height, pick.length ? tl.scenes[1].start + 1 : 1, data, tl);
  }, [data, mode, fmt.w, fmt.h]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && (!pics || !videos)) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!pics || !videos || !brand) return <div className="card panel">Loading…</div>;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (p) => setPick((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= 8 ? (toast('At most 8 pictures in one video'), cur) : [...cur, { id: p.id, caption: p.headline || '' }]));
  const move = (i, d) => setPick((cur) => { const n = [...cur]; const j = i + d; if (j < 0 || j >= n.length) return cur; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const run = (record) => {
    if (!ready) { toast('Pick at least one picture (and wait for it to load)'); return; }
    if (stopRef.current) stopRef.current();
    setMode(record ? 'record' : 'preview'); setProg(0); if (record) setMade(null);
    stopRef.current = play(canvasRef.current, data, {
      secPer: Number(f.secPer), record,
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
        params: { title: f.title || f.headline || 'Slideshow video', aspect: f.format, scenes: pick.length, seconds: Math.round(tl.total), logo: f.useLogo && logo ? '1' : '0', headline: f.headline, ...(getState().dept ? { department: getState().dept } : {}) },
        timeout: 300000,
      });
      if (andSubmit) { const s = await omni.post(`/gs/marketing/images/${r.item.id}/submit`); toast(s.ok); } else toast('Video saved');
      setMade(null); setTab(''); load();
    } catch (e) { toast(errOf(e, 'The video could not be saved.')); } finally { setBusy(''); }
  };
  const act = async (it, what) => { setBusy(it.id); try { if (what === 'submit') { const r = await omni.post(`/gs/marketing/images/${it.id}/submit`); toast(r.ok); } load(); } catch (e) { toast(errOf(e, 'That did not work.')); } finally { setBusy(''); } };
  const remove = async () => { const it = del; setDel(null); try { await omni.del(`/gs/marketing/images/${it.id}`); toast('Deleted'); load(); } catch (e) { toast(errOf(e, 'It could not be deleted.')); } };
  const copyLink = async (it) => { const url = `${window.location.origin}${it.publicPath}`; try { await navigator.clipboard.writeText(url); toast('Public link copied'); } catch { window.prompt('Copy the public link:', url); } };
  const shown = tab ? videos.filter((v) => v.status === tab) : videos;
  const cnt = (s) => videos.filter((v) => v.status === s).length;
  const type = recordType();
  const ratio = (a) => { const [w, h] = String(a || '1:1').split(':').map(Number); return `${w} / ${h}`; };

  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI Video" lead="Turn approved pictures into a short video with your logo, colours, captions and a call to action. It is made in this browser: free, nothing is sent anywhere until you save it." />
      {!type ? <Banner tone="error">This browser cannot record video. Use a recent Chrome or Edge on a computer.</Banner> : !type.includes('mp4') ? <Banner tone="warn">This browser records WebM, not MP4. WhatsApp and Facebook take WebM; for Instagram use Chrome or Edge, which make MP4.</Banner> : null}
      {err ? <Banner tone="error">{err}</Banner> : null}
      {canWrite ? (
        <>
          <Panel title="1 · Pick the pictures" sub={pics.length ? `Tap pictures in the order they should play (up to 8). ${pick.length} picked.` : undefined}>
            {pics.length === 0 ? <Empty title="No approved pictures yet" action={<Btn onClick={() => go('mkimages')}>Make pictures in AI Images</Btn>}>A video is made from approved pictures. Make some in AI Images and get them approved first.</Empty> : (
              <div className="mki-pick" style={{ maxHeight: 260 }}>
                {pics.map((p) => { const n = pick.findIndex((x) => x.id === p.id); return (
                  <button type="button" key={p.id} className={n >= 0 ? 'on' : ''} title={p.title} onClick={() => toggle(p)} style={{ position: 'relative' }}>
                    <MkImg id={p.id} alt={p.title} style={{ height: '100%', borderRadius: 8 }} />
                    {n >= 0 ? <span style={{ position: 'absolute', top: 4, left: 4, background: '#0f766e', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 800, padding: '1px 6px' }}>{n + 1}</span> : null}
                  </button>
                ); })}
              </div>
            )}
          </Panel>

          {pick.length > 0 && (
            <div className="mk-two" style={{ marginTop: 14 }}>
              <Panel title="2 · Words and look" sub={`${Math.round(tl.total)} seconds in all · intro, ${pick.length} picture${pick.length === 1 ? '' : 's'}, outro`}>
                <div className="form-grid">
                  <Field label="NAME OF THE VIDEO" full><input value={f.title} maxLength={80} onChange={set('title')} placeholder="Nurse hiring drive video" /></Field>
                  <Field label="SIZE"><select value={f.format} onChange={set('format')} disabled={!!mode}>{Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
                  <Field label="SECONDS PER PICTURE"><select value={f.secPer} onChange={(e) => setF({ ...f, secPer: Number(e.target.value) })} disabled={!!mode}>{[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
                  <Field label="INTRO HEADLINE" full><input value={f.headline} maxLength={70} onChange={set('headline')} /></Field>
                  <Field label="INTRO LINE UNDER IT" full><input value={f.tagline} maxLength={80} onChange={set('tagline')} /></Field>
                  {pick.map((p, i) => (
                    <Field key={p.id} label={<span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>PICTURE {i + 1} CAPTION <TinyBtn onClick={() => move(i, -1)} disabled={i === 0 || !!mode} aria-label="Earlier">↑</TinyBtn><TinyBtn onClick={() => move(i, 1)} disabled={i === pick.length - 1 || !!mode} aria-label="Later">↓</TinyBtn></span>} full>
                      <input value={p.caption} maxLength={90} placeholder="Optional words on this picture" onChange={(e) => setPick((cur) => cur.map((x) => (x.id === p.id ? { ...x, caption: e.target.value } : x)))} />
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
                      <Btn disabled={!ready} onClick={() => run(false)}>▶ Preview</Btn>
                      <Btn primary disabled={!ready || !type} onClick={() => run(true)}>⏺ Make the video ({Math.round(tl.total)}s)</Btn>
                    </>
                  )}
                </div>
                {!ready && pick.length ? <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center', marginTop: 6 }}>Loading the pictures…</div> : null}
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

      <Panel title="Your videos" sub="Newest first" style={{ marginTop: 14 }} right={<span className="pill live">{videos.length}</span>}>
        <Tabs value={tab} onChange={setTab} tabs={[['', 'All', videos.length], ['draft', 'Saved', cnt('draft')], ['waiting', 'Waiting', cnt('waiting')], ['changes', 'Changes needed', cnt('changes')], ['approved', 'Approved', cnt('approved')]]} />
        {shown.length === 0 ? <Empty title="No videos here yet">{videos.length ? 'Nothing with that status.' : 'Pick pictures above and press Make the video.'}</Empty> : (
          <div className="mki-grid">
            {shown.map((v) => (
              <div key={v.id} className="card mki-card">
                <div style={{ aspectRatio: ratio(v.aspect), overflow: 'hidden', borderRadius: 10, background: '#000' }}><MkImg id={v.id} alt={v.title} video style={{ height: '100%', objectFit: 'contain', background: '#000' }} /></div>
                <b style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 8 }} title={v.title}>{v.title}</b>
                <div style={{ margin: '3px 0' }}><MkStatus status={v.status} /></div>
                <small style={{ color: 'var(--muted)', fontSize: 9.5 }}>{v.prompt} · {v.aspect} · {(v.bytes / 1048576).toFixed(1)} MB · {fmtDateTime(v.createdAt)}{!v.mine ? ` · ${v.createdByName}` : ''}</small>
                {v.status === 'changes' && v.note ? <div className="mk-note">Sent back by {v.decidedByName}: {v.note}</div> : null}
                <div className="mk-acts" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <TinyBtn onClick={() => downloadMkImg(v.id, v.title).catch((e) => toast(errOf(e, 'It could not be downloaded.')))}>⬇ Download</TinyBtn>
                  {v.canSubmit ? <TinyBtn disabled={busy === v.id} onClick={() => act(v, 'submit')}>Ask for approval</TinyBtn> : null}
                  {v.publicPath ? <TinyBtn onClick={() => copyLink(v)}>🔗 Copy link</TinyBtn> : null}
                  {v.canDelete ? <TinyBtn onClick={() => setDel(v)} aria-label={`Delete ${v.title}`}>🗑</TinyBtn> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {del ? <ConfirmModal danger title={`Delete "${del.title}"?`} text={del.status === 'approved' ? 'Its public link stops working and calendar posts that use it lose the video.' : 'The video is removed.'} yes="Delete" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
